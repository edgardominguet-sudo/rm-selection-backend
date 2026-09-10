import { createHash, randomUUID } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { broadcastChange } from "../realtime";
import { buildStorageKey, uploadObject, deleteObject } from "../storage/r2Client";
import { fetchAndDownscale } from "./imageDownscale";
import { extractLandmarksFromPhoto } from "./landmarkVisionClient";
import { normalizeMediaUrl } from "./mediaFingerprint";
import { CatalogMediaItem } from "../types";
import { ViewName } from "./landmarks";
import { analyzeHipOnDemand } from "../rankingService";

/**
 * ANÁLISIS AUTOMÁTICO Y SILENCIOSO DE FOTOS DE MEDIA (2026-09-10, a
 * pedido explícito de Ramon; ajustado el mismo día para procesar TODO el
 * catálogo pendiente por corrida, en paralelo controlado, en vez de un
 * tope fijo de Hips). Flujo completo:
 *
 *   CASA DE VENTA PUBLICA/ACTUALIZA UNA FOTO → RM SELECTION LA INCORPORA
 *   A MEDIA (ver mediaSweepService.ts, que arma la lista de Hips con foto
 *   pendiente y la procesa con concurrencia limitada, ver
 *   `util/concurrencyPool.ts`) → se clasifica CADA foto publicada con el
 *   mismo motor de visión que ya usa el análisis (extractLandmarksFromPhoto,
 *   sin `expectedView` — clasificación NO sesgada) hasta encontrar la
 *   primera que el motor identifique, con confianza suficiente, como
 *   LATERAL → esa foto se guarda como la tarjeta LATERAL de Análisis IA
 *   (MediaAsset AI_ANALYSIS_PHOTO, el mismo "casillero" que ya usa la
 *   foto lateral manual) → se llama al MISMO motor que ya usa el botón
 *   manual "Analizar" (`analyzeHipOnDemand`, rankingService.ts) → el
 *   score queda disponible en Análisis IA exactamente con el mismo
 *   mecanismo/formato de siempre, sin que el usuario tenga que tocar
 *   nada.
 *
 * DIFERENCIA DELIBERADA con analysis/autoVideoAnalysis.ts (que resuelve
 * el mismo problema para video, ver ese archivo): acá NO hay extracción
 * de fotograma ni ffmpeg — se trabaja directo con las FOTOS ya publicadas
 * en `mediaJson`. El paso extra que esta función sí necesita y el video
 * no: identificar CUÁL de las fotos publicadas es la LATERAL, porque
 * ninguna casa de ventas etiqueta sus fotos por vista (confirmado en
 * saleHouses/keeneland.ts y saleHouses/fasigTipton.ts — CatalogMediaItem
 * nunca trae `conformationView` desde el catálogo). Por pedido explícito
 * de Ramon, este mecanismo es completamente independiente del de video:
 * ninguno de los dos reutiliza al otro, ninguno pisa el trabajo del otro,
 * y esta función JAMÁS analiza video ni extrae fotogramas.
 *
 * REGLAS DURAS (pedido explícito de Ramon, 2026-09-10):
 * 1) NUNCA pisa una foto LATERAL que el usuario haya puesto a mano —
 *    mismo criterio que autoVideoAnalysis.ts: una foto LATERAL "manual"
 *    siempre tiene `deviceId` real (subida desde un iPhone/iPad
 *    concreto); una foto automática se graba SIEMPRE con
 *    `deviceId: null`. En cuanto el usuario toma o importa su propia
 *    foto LATERAL, esta automatización deja esa tarjeta en paz para
 *    siempre (hasta que el usuario la borre) — los botones
 *    "Analizar"/"Reanalizar" y la importación manual desde Media siguen
 *    intactos y con total prioridad.
 * 2) NUNCA reprocesa la misma foto de nuevo (ver
 *    `Hip.autoLateralPhotoSourceUrl` en schema.prisma) — evita análisis
 *    duplicados: solo se vuelve a intentar cuando la foto usada
 *    desaparece de la lista publicada hoy, o cuando todavía no se
 *    encontró ninguna foto clasificable como LATERAL.
 * 3) NUNCA fuerza un resultado: si ninguna foto publicada puede
 *    clasificarse como LATERAL con confianza suficiente
 *    (`MIN_AUTO_CLASSIFICATION_CONFIDENCE`), no se crea ninguna tarjeta
 *    ni se guarda ningún score — se reintenta en el próximo barrido, sin
 *    marcar nada como "ya procesado".
 * 4) Asociación estricta HIP → FOTO → ANÁLISIS: la tarjeta se crea con
 *    `hipId` fijo desde el propio Hip que se está procesando, igual que
 *    cualquier otra foto de la app.
 * 5) Completamente silencioso: corre solo desde el barrido de Media
 *    server-side (mediaSweepService.ts) — no hay ningún camino de UI que
 *    lo dispare. El único rastro visible para el usuario es el resultado
 *    ya aplicado (foto + score + hallazgos) la próxima vez que abra
 *    Análisis IA.
 * 6) No modifica en nada el motor de análisis ni el flujo manual: usa
 *    exactamente el mismo `analyzeHipOnDemand` que ya usa el botón
 *    manual y la importación manual desde Media, sin tocar una sola
 *    línea de ese motor ni de su criterio de puntaje.
 * 7) Reintentos ACOTADOS ante fallos técnicos reales (descarga o
 *    clasificación que ni siquiera pudieron completarse — ver
 *    `MAX_CONSECUTIVE_FAILED_ATTEMPTS`): un Hip que falla técnicamente
 *    corrida tras corrida con EL MISMO conjunto de fotos deja de
 *    reintentarse automáticamente después de unos pocos intentos
 *    consecutivos, para no insistir para siempre contra algo roto — pero
 *    en cuanto aparece una foto nueva/distinta para ese Hip, el contador
 *    se reinicia solo. Un resultado "ninguna foto es LATERAL" (motor
 *    funcionando bien, simplemente no hay candidata) NUNCA cuenta como
 *    fallo — no tiene tope de reintentos, es un resultado válido.
 */

/**
 * Confianza mínima para aceptar la clasificación automática de una foto
 * de catálogo como LATERAL. Deliberadamente más exigente que
 * `MIN_ACTIONABLE_CONFIDENCE` (0.55, severity.ts — el piso para que UN
 * hallazgo puntual cuente dentro de un análisis ya iniciado por el
 * usuario): acá la decisión es más sensible, porque de ella depende si
 * se crea o no una tarjeta LATERAL nueva y se dispara un análisis
 * completo sin ningún control humano de por medio — pedido explícito de
 * Ramon: "si no puede determinarse con suficiente confianza que una foto
 * es LATERAL, no forzar el análisis ni guardar un resultado incorrecto".
 */
const MIN_AUTO_CLASSIFICATION_CONFIDENCE = 0.65;

/** Mismo tope que usa el motor de análisis normal para fotos por Hip (ver anthropicClient.ts, `photoItems.slice(0, 6)`) — nunca clasifica más de 6 fotos publicadas buscando la LATERAL. */
const MAX_AUTO_PHOTO_CLASSIFICATIONS_PER_HIP_CALL = 6;

/**
 * Tope de intentos CONSECUTIVOS fallidos técnicamente (no de fotos
 * evaluadas como "no lateral" — eso nunca cuenta como fallo) para el
 * MISMO conjunto de fotos publicadas de un Hip, antes de dejar de
 * reintentar automáticamente — regla 7 arriba. Configurable por entorno
 * (`AUTO_PHOTO_ANALYSIS_MAX_FAILED_ATTEMPTS`) sin necesidad de
 * redeployar código; ver config.ts.
 */
const MAX_CONSECUTIVE_FAILED_ATTEMPTS = config.autoPhotoAnalysisMaxFailedAttempts;

/**
 * Resultado de un intento, para que mediaSweepService.ts pueda contar y
 * reportarle a Ramon un resumen exacto de la corrida (cuántas fotos
 * pendientes encontró, cuántas analizó correctamente, cuántas
 * fallaron) — pedido explícito 2026-09-10.
 */
export type AutoPhotoAnalysisOutcome =
  | "no_photo" // el Hip no tiene ninguna foto publicada en Media todavía.
  | "already_processed" // idempotencia: la foto vigente ya fue procesada antes (regla 2).
  | "no_eligible_org" // todas las organizaciones ya tienen una LATERAL manual puesta a mano (regla 1) — nada que hacer.
  | "retries_exhausted" // tope de fallos técnicos consecutivos alcanzado para este mismo conjunto de fotos (regla 7) — se salta hasta que cambie la foto o se revise a mano.
  | "no_lateral_candidate" // el motor funcionó bien, pero ninguna foto publicada clasificó como LATERAL con confianza suficiente (regla 3) — resultado válido, no es un fallo.
  | "applied" // se encontró una foto LATERAL, se guardó y se analizó correctamente en al menos una organización.
  | "failed"; // fallo técnico real (descarga, IA, subida a R2, o base de datos) — se reintentará en la próxima corrida, sujeto al tope de la regla 7.

function catalogPhotoUrls(media: CatalogMediaItem[]): string[] {
  return media.filter((m) => m.kind === "photo" && !!m.url).map((m) => m.url);
}

function photoSetFingerprint(normalizedUrls: string[]): string {
  return createHash("sha256").update([...normalizedUrls].sort().join("|")).digest("hex");
}

/** Registra un fallo técnico (regla 7) — separado del resultado principal para no repetir la lectura del Hip en cada punto de salida por error. */
async function registerFailedAttempt(hip: { id: string; hipNumber: string }, baselineFailedAttempts: number, photoFingerprint: string): Promise<void> {
  const next = baselineFailedAttempts + 1;
  await db.hip.update({
    where: { id: hip.id },
    data: { autoLateralPhotoFailedAttempts: next, autoLateralPhotoLastAttemptedFingerprint: photoFingerprint },
  });
  if (next === MAX_CONSECUTIVE_FAILED_ATTEMPTS) {
    console.warn(`[auto-photo-analysis] Hip ${hip.hipNumber}: alcanzó ${next} intentos fallidos técnicos consecutivos con el mismo conjunto de fotos — se deja de reintentar automáticamente hasta que aparezca una foto nueva o se revise a mano.`);
  }
}

/** Registra un intento técnicamente exitoso (haya o no encontrado LATERAL) — limpia el contador de fallos si venía de una racha fallida. */
async function registerHealthyAttempt(hip: { id: string }, baselineFailedAttempts: number, photoFingerprint: string, storedFingerprint: string | null): Promise<void> {
  if (baselineFailedAttempts === 0 && storedFingerprint === photoFingerprint) return; // nada que actualizar — ya estaba limpio y con la misma huella.
  await db.hip.update({
    where: { id: hip.id },
    data: { autoLateralPhotoFailedAttempts: 0, autoLateralPhotoLastAttemptedFingerprint: photoFingerprint },
  });
}

/**
 * Único punto de entrada. Se llama desde mediaSweepService.ts en cada
 * corrida del barrido (mismo criterio que `autoAnalyzeNewCatalogVideoIfNeeded`
 * — ver el comentario "bug real encontrado" en mediaSweepService.ts:
 * evaluar en cada barrido, no solo cuando `mediaJson` cambió esta
 * corrida, es necesario para no dejar un Hip atascado si la primera
 * pasada no encontró ninguna foto clasificable como LATERAL), CON
 * CONCURRENCIA LIMITADA (ver `util/concurrencyPool.ts` y
 * `config.autoPhotoAnalysisConcurrency`) — ya NO hay tope de cantidad de
 * Hips por corrida (pedido explícito de Ramon 2026-09-10: "procesar
 * TODAS las fotos pendientes en esa misma corrida"); la protección de
 * costo/estabilidad pasó a ser la concurrencia acotada + los reintentos
 * acotados (regla 7) en vez de un presupuesto de cantidad. Recibe el Hip
 * ya actualizado (con el mediaJson fresco) y decide sola si hay trabajo
 * real que hacer. Nunca tira excepción hacia arriba (todo error queda
 * contenido acá, logueado) — un problema puntual de un Hip jamás debe
 * interrumpir el barrido de Media del resto del catálogo.
 */
export async function autoAnalyzeNewCatalogPhotoIfNeeded(hip: {
  id: string;
  hipNumber: string;
  horseName: string | null;
  autoLateralPhotoSourceUrl: string | null;
  autoLateralPhotoFailedAttempts: number;
  autoLateralPhotoLastAttemptedFingerprint: string | null;
}, freshMedia: CatalogMediaItem[]): Promise<AutoPhotoAnalysisOutcome> {
  try {
    const photoUrls = catalogPhotoUrls(freshMedia);
    if (photoUrls.length === 0) return "no_photo";

    // Idempotencia (regla 2): si la foto que YA se usó para la tarjeta
    // LATERAL automática vigente sigue estando entre las fotos publicadas
    // hoy, no hay nada nuevo que hacer. Recién cuando esa foto YA NO
    // aparece en absoluto en la lista de hoy (la casa de ventas la
    // reemplazó de verdad) se reintenta la lista completa desde el
    // principio.
    const normalizedToday = photoUrls.map(normalizeMediaUrl);
    if (hip.autoLateralPhotoSourceUrl && normalizedToday.includes(hip.autoLateralPhotoSourceUrl)) return "already_processed";

    // Tope de reintentos (regla 7): si el conjunto de fotos publicadas
    // hoy es EXACTAMENTE el mismo que ya agotó los intentos técnicos la
    // última vez, se salta sin gastar nada — apenas cambie la foto (URL
    // nueva/distinta), la huella cambia y el contador vuelve a cero solo.
    const photoFingerprint = photoSetFingerprint(normalizedToday);
    const failedAttemptsBaseline = hip.autoLateralPhotoLastAttemptedFingerprint === photoFingerprint ? hip.autoLateralPhotoFailedAttempts : 0;
    if (failedAttemptsBaseline >= MAX_CONSECUTIVE_FAILED_ATTEMPTS) return "retries_exhausted";

    // Averigua, ANTES de gastar clasificación de IA en ninguna foto, si
    // hay al menos una organización para la que valga la pena (regla 1:
    // nunca pisar una LATERAL manual). Si ninguna organización califica,
    // no se clasifica nada — y a propósito NO se toca
    // `autoLateralPhotoSourceUrl` ni el contador de reintentos, así que
    // si el usuario borra su foto manual más adelante, el próximo
    // barrido vuelve a evaluar este mismo Hip desde cero.
    const organizations = await db.organization.findMany({ select: { id: true } });
    if (organizations.length === 0) return "no_eligible_org";

    type Eligible = { organizationId: string; existingAutoAssetId: string | null; existingAutoStorageKey: string | null };
    const eligible: Eligible[] = [];
    for (const org of organizations) {
      const currentLateral = await db.mediaAsset.findFirst({
        where: { hipId: hip.id, organizationId: org.id, kind: "AI_ANALYSIS_PHOTO", conformationView: "lateral", deletedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (currentLateral && currentLateral.deviceId) continue; // Foto manual real — no se toca.
      eligible.push({
        organizationId: org.id,
        existingAutoAssetId: currentLateral?.id ?? null,
        existingAutoStorageKey: currentLateral?.storageKey ?? null,
      });
    }
    if (eligible.length === 0) return "no_eligible_org";

    // Clasifica cada foto publicada, en orden, hasta encontrar la
    // primera que el motor identifique como LATERAL con confianza
    // suficiente (regla 3 — nunca se fuerza el resultado). Reusa el
    // mismo clasificador de visión que ya usa el análisis normal
    // (extractLandmarksFromPhoto), SIN `expectedView`, exactamente igual
    // que el Paso 2 de anthropicClient.analyzeHip — así que el resultado
    // de esta clasificación es 100% consistente con el criterio que la
    // app ya usa hoy para decidir si una foto "es" lateral. Se rastrea
    // por separado si AL MENOS UNA foto se pudo clasificar de verdad
    // (para distinguir "ninguna es lateral" de "fallo técnico total",
    // regla 7).
    let lateralPhoto: Buffer | null = null;
    let lateralSourceUrl: string | null = null;
    let atLeastOneClassificationSucceeded = false;
    for (const url of photoUrls.slice(0, MAX_AUTO_PHOTO_CLASSIFICATIONS_PER_HIP_CALL)) {
      const jpeg = await fetchAndDownscale(url);
      if (!jpeg) continue;
      try {
        const extraction = await extractLandmarksFromPhoto({
          jpeg,
          photoLabel: `Foto de catálogo del Hip ${hip.hipNumber} (clasificación automática de Media)`,
        });
        atLeastOneClassificationSucceeded = true;
        if (extraction.valid && extraction.view === "lateral" && extraction.overallConfidence >= MIN_AUTO_CLASSIFICATION_CONFIDENCE) {
          lateralPhoto = jpeg;
          lateralSourceUrl = url;
          break;
        }
      } catch (err) {
        // Una foto puntual que no se puede clasificar (error de red,
        // timeout de la IA, formato inesperado) simplemente se salta —
        // se sigue probando con las demás fotos publicadas.
        console.error(`[auto-photo-analysis] Hip ${hip.hipNumber}: error clasificando una foto de catálogo:`, err);
      }
    }

    if (!lateralPhoto || !lateralSourceUrl) {
      if (atLeastOneClassificationSucceeded) {
        // Resultado válido (regla 3): el motor funcionó, ninguna foto
        // publicada es LATERAL con confianza suficiente. NO es un fallo.
        await registerHealthyAttempt(hip, failedAttemptsBaseline, photoFingerprint, hip.autoLateralPhotoLastAttemptedFingerprint);
        return "no_lateral_candidate";
      }
      // Fallo técnico real: NINGUNA foto candidata se pudo ni descargar
      // ni clasificar — cuenta para el tope de reintentos (regla 7).
      await registerFailedAttempt(hip, failedAttemptsBaseline, photoFingerprint);
      return "failed";
    }

    let appliedForAtLeastOneOrg = false;
    for (const org of eligible) {
      try {
        const user = await db.user.findFirst({ where: { organizationId: org.organizationId, role: "OWNER" } })
          ?? await db.user.findFirst({ where: { organizationId: org.organizationId } });
        if (!user) continue;

        // Regla "una foto = un registro" (mismo criterio que
        // autoVideoAnalysis.ts y que addAIAnalysisPhoto en la app): si ya
        // había una foto LATERAL automática anterior en esta tarjeta, se
        // tombstona antes de crear la nueva.
        if (org.existingAutoAssetId) {
          await db.mediaAsset.update({ where: { id: org.existingAutoAssetId }, data: { deletedAt: new Date() } });
          if (org.existingAutoStorageKey) {
            deleteObject(org.existingAutoStorageKey).catch((err) => console.error(`[auto-photo-analysis] No se pudo borrar el objeto viejo de R2:`, err));
          }
        }

        const contentType = "image/jpeg";
        const assetId = randomUUID();
        const storageKey = buildStorageKey({ organizationId: org.organizationId, hipId: hip.id, kind: "AI_ANALYSIS_PHOTO", mediaAssetId: assetId, contentType });
        await uploadObject(storageKey, lateralPhoto, contentType);

        await db.mediaAsset.create({
          data: {
            id: assetId,
            userId: user.id,
            organizationId: org.organizationId,
            hipId: hip.id,
            deviceId: null, // Marca "generado automáticamente" — ver regla 1 arriba.
            kind: "AI_ANALYSIS_PHOTO",
            contentType,
            byteSize: lateralPhoto.length,
            storageKey,
            conformationView: "lateral",
            uploadStatus: "PROCESSED",
          },
        });
        broadcastChange("media", null);

        // Mismo motor que el botón manual "Analizar" — regla "no
        // sobrescribir innecesariamente"/"evitar duplicados" ya queda
        // resuelta acá adentro (analyzeHipOnDemand compara el id del
        // MediaAsset ganador de esta vista contra el análisis vigente y
        // solo vuelve a llamar a la IA si de verdad cambió, ver
        // rankingService.ts).
        await analyzeHipOnDemand(
          { id: hip.id, hipNumber: hip.hipNumber, horseName: hip.horseName },
          org.organizationId,
          undefined,
          "lateral" as ViewName
        );
        broadcastChange("analysis", null);
        appliedForAtLeastOneOrg = true;
        console.log(`[auto-photo-analysis] Hip ${hip.hipNumber}: foto LATERAL automática de Media aplicada y analizada (org ${org.organizationId}).`);
      } catch (err) {
        // Un fallo de IA (referente faltante, error transitorio del
        // servidor, etc.) para UNA organización no debe impedir que otra
        // organización, ni el resto del barrido, sigan su curso — el
        // MediaAsset ya quedó guardado igual; el próximo barrido puede
        // terminar de analizarlo.
        console.error(`[auto-photo-analysis] Hip ${hip.hipNumber}, org ${org.organizationId}: error aplicando análisis automático de foto:`, err);
      }
    }

    if (appliedForAtLeastOneOrg) {
      await db.hip.update({
        where: { id: hip.id },
        data: { autoLateralPhotoSourceUrl: normalizeMediaUrl(lateralSourceUrl), autoLateralPhotoFailedAttempts: 0, autoLateralPhotoLastAttemptedFingerprint: photoFingerprint },
      });
      return "applied";
    }
    // Se encontró una foto LATERAL válida pero no se pudo aplicar en
    // NINGUNA organización (fallo de subida a R2, de base de datos, o de
    // análisis para todas) — fallo técnico real, cuenta para el tope de
    // reintentos.
    await registerFailedAttempt(hip, failedAttemptsBaseline, photoFingerprint);
    return "failed";
  } catch (err) {
    console.error(`[auto-photo-analysis] Hip ${hip.hipNumber}: error inesperado, se aborta sin romper el barrido:`, err);
    return "failed";
  }
}
