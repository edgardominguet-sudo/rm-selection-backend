import { randomUUID } from "node:crypto";
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
 * pedido explícito de Ramon). Flujo completo:
 *
 *   CASA DE VENTA PUBLICA/ACTUALIZA UNA FOTO → RM SELECTION LA INCORPORA
 *   A MEDIA (ver mediaSweepService.ts, que llama a
 *   `autoAnalyzeNewCatalogPhotoIfNeeded` apenas confirma que
 *   `hip.mediaJson` trae foto nueva/distinta) → se clasifica CADA foto
 *   publicada con el mismo motor de visión que ya usa el análisis
 *   (extractLandmarksFromPhoto, sin `expectedView` — clasificación NO
 *   sesgada) hasta encontrar la primera que el motor identifique, con
 *   confianza suficiente, como LATERAL → esa foto se guarda como la
 *   tarjeta LATERAL de Análisis IA (MediaAsset AI_ANALYSIS_PHOTO, el
 *   mismo "casillero" que ya usa la foto lateral manual) → se llama al
 *   MISMO motor que ya usa el botón manual "Analizar"
 *   (`analyzeHipOnDemand`, rankingService.ts) → el score queda
 *   disponible en Análisis IA exactamente con el mismo mecanismo/formato
 *   de siempre, sin que el usuario tenga que tocar nada.
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
 * Presupuesto compartido de clasificaciones automáticas DENTRO DE UNA
 * SOLA corrida del barrido de Media (mismo espíritu que `AnalysisBudget`
 * en rankingService.ts) — protección de costo/estabilidad real, no
 * teórica: a diferencia del video (raro, solo algunos Hips tienen video
 * pendiente en un momento dado), PRÁCTICAMENTE TODOS los Hips de una
 * venta ya tienen una foto de catálogo (Keeneland: `field_main_image`
 * siempre presente) — sin este tope, la primera corrida contra una venta
 * grande (ej. Keeneland September, ~4600 Hips) intentaría clasificar con
 * IA miles de fotos EN UNA SOLA llamada al endpoint de barrido (manual o
 * del cron 3am), lo que la dejaría corriendo horas, arriesgaría el
 * timeout del proxy/HTTP de Railway en la corrida manual, y gastaría de
 * golpe una cantidad enorme e impredecible de la API de Anthropic. Con
 * este tope, cada corrida del barrido clasifica como máximo esta
 * cantidad de Hips NUEVOS (nunca antes procesados) y deja el resto para
 * la próxima corrida — nada se pierde, la carga inicial de un catálogo
 * grande simplemente se reparte en varias corridas (manuales o del cron
 * nocturno) en vez de una sola. Los Hips ya procesados (idempotencia vía
 * `autoLateralPhotoSourceUrl`) o sin ninguna organización elegible NUNCA
 * consumen presupuesto — solo lo gastan los Hips donde de verdad hace
 * falta llamar a la IA.
 */
export interface AutoPhotoAnalysisBudget {
  remaining: number;
}

/** Tope por defecto de Hips nuevos clasificados por corrida de barrido — ver `AutoPhotoAnalysisBudget` arriba. Deliberadamente conservador: a ~5-15s por clasificación, 25 Hips mantiene una corrida manual dentro de un tiempo de respuesta razonable (unos pocos minutos) incluso contra una venta grande nunca antes procesada. */
export const DEFAULT_AUTO_PHOTO_ANALYSIS_BUDGET = 25;

function catalogPhotoUrls(media: CatalogMediaItem[]): string[] {
  return media.filter((m) => m.kind === "photo" && !!m.url).map((m) => m.url);
}

/**
 * Único punto de entrada. Se llama desde mediaSweepService.ts en cada
 * corrida del barrido (mismo criterio que `autoAnalyzeNewCatalogVideoIfNeeded`
 * — ver el comentario "bug real encontrado" en mediaSweepService.ts:
 * evaluar en cada barrido, no solo cuando `mediaJson` cambió esta
 * corrida, es necesario para no dejar un Hip atascado si la primera
 * pasada no encontró ninguna foto clasificable como LATERAL). Recibe el
 * Hip ya actualizado (con el mediaJson fresco) y decide sola si hay
 * trabajo real que hacer. Nunca tira excepción hacia arriba (todo error
 * queda contenido acá, logueado) — un problema puntual de un Hip jamás
 * debe interrumpir el barrido de Media del resto del catálogo.
 */
export async function autoAnalyzeNewCatalogPhotoIfNeeded(hip: {
  id: string;
  hipNumber: string;
  horseName: string | null;
  autoLateralPhotoSourceUrl: string | null;
}, freshMedia: CatalogMediaItem[], budget: AutoPhotoAnalysisBudget): Promise<void> {
  try {
    const photoUrls = catalogPhotoUrls(freshMedia);
    if (photoUrls.length === 0) return;

    // Idempotencia (regla 2): si la foto que YA se usó para la tarjeta
    // LATERAL automática vigente sigue estando entre las fotos publicadas
    // hoy, no hay nada nuevo que hacer. Recién cuando esa foto YA NO
    // aparece en absoluto en la lista de hoy (la casa de ventas la
    // reemplazó de verdad) se reintenta la lista completa desde el
    // principio.
    const normalizedToday = photoUrls.map(normalizeMediaUrl);
    if (hip.autoLateralPhotoSourceUrl && normalizedToday.includes(hip.autoLateralPhotoSourceUrl)) return;

    // Averigua, ANTES de gastar clasificación de IA en ninguna foto, si
    // hay al menos una organización para la que valga la pena (regla 1:
    // nunca pisar una LATERAL manual). Si ninguna organización califica,
    // no se clasifica nada — y a propósito NO se actualiza
    // `autoLateralPhotoSourceUrl`, así que si el usuario borra su foto
    // manual más adelante, el próximo barrido vuelve a evaluar este mismo
    // Hip desde cero.
    const organizations = await db.organization.findMany({ select: { id: true } });
    if (organizations.length === 0) return;

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
    if (eligible.length === 0) return;

    // Presupuesto de la corrida (ver AutoPhotoAnalysisBudget arriba):
    // recién ACÁ hay trabajo real que hacer (idempotencia y elegibilidad
    // ya pasaron), así que es el punto correcto para gastar una unidad
    // de presupuesto. Si ya no queda, se deja este Hip para la próxima
    // corrida del barrido — sin tocar `autoLateralPhotoSourceUrl`, así
    // que no se pierde ni se marca como "ya intentado".
    if (budget.remaining <= 0) {
      console.log(`[auto-photo-analysis] Hip ${hip.hipNumber}: presupuesto de clasificaciones de esta corrida agotado — se reintenta en la próxima.`);
      return;
    }
    budget.remaining -= 1;

    // Clasifica cada foto publicada, en orden, hasta encontrar la
    // primera que el motor identifique como LATERAL con confianza
    // suficiente (regla 3 — nunca se fuerza el resultado). Reusa el
    // mismo clasificador de visión que ya usa el análisis normal
    // (extractLandmarksFromPhoto), SIN `expectedView`, exactamente igual
    // que el Paso 2 de anthropicClient.analyzeHip — así que el resultado
    // de esta clasificación es 100% consistente con el criterio que la
    // app ya usa hoy para decidir si una foto "es" lateral.
    let lateralPhoto: Buffer | null = null;
    let lateralSourceUrl: string | null = null;
    for (const url of photoUrls.slice(0, MAX_AUTO_PHOTO_CLASSIFICATIONS_PER_HIP_CALL)) {
      const jpeg = await fetchAndDownscale(url);
      if (!jpeg) continue;
      try {
        const extraction = await extractLandmarksFromPhoto({
          jpeg,
          photoLabel: `Foto de catálogo del Hip ${hip.hipNumber} (clasificación automática de Media)`,
        });
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
      console.log(`[auto-photo-analysis] Hip ${hip.hipNumber}: ninguna foto publicada en Media se pudo clasificar como LATERAL con confianza suficiente todavía — se reintenta en el próximo barrido.`);
      return;
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
      await db.hip.update({ where: { id: hip.id }, data: { autoLateralPhotoSourceUrl: normalizeMediaUrl(lateralSourceUrl) } });
    }
  } catch (err) {
    console.error(`[auto-photo-analysis] Hip ${hip.hipNumber}: error inesperado, se aborta sin romper el barrido:`, err);
  }
}
