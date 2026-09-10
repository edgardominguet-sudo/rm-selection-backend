import { randomUUID } from "node:crypto";
import { db } from "../db";
import { broadcastChange } from "../realtime";
import { buildStorageKey, uploadObject, deleteObject } from "../storage/r2Client";
import { extractRepresentativeVideoFrame } from "./frameExtraction";
import { normalizeMediaUrl } from "./mediaFingerprint";
import { CatalogMediaItem } from "../types";
import { ViewName } from "./landmarks";
import { analyzeHipOnDemand } from "../rankingService";

/**
 * ANÁLISIS AUTOMÁTICO Y SILENCIOSO DE VIDEOS DE MEDIA (2026-09-10, a
 * pedido explícito de Ramon). Flujo completo:
 *
 *   CASA DE VENTA PUBLICA VIDEO → RM SELECTION LO INCORPORA A MEDIA (ver
 *   mediaSweepService.ts, que llama a `autoAnalyzeNewCatalogVideoIfNeeded`
 *   apenas confirma que `hip.mediaJson` trae video nuevo/distinto) →
 *   se extrae UN fotograma representativo del video (frameExtraction.ts,
 *   servidor, determinístico) → ese fotograma se guarda como una foto MÁS
 *   de Análisis IA (MediaAsset AI_ANALYSIS_PHOTO, tarjeta LATERAL — el
 *   mismo "casillero" que ya usa la marcha/postura de perfil) → se llama
 *   al MISMO motor que ya usa el botón manual "Analizar"
 *   (`analyzeHipOnDemand`, rankingService.ts) → el score queda disponible
 *   en Análisis IA exactamente con el mismo mecanismo/formato de siempre.
 *
 * REGLAS DURAS (pedido explícito):
 * 1) NUNCA pisa una foto LATERAL que el usuario haya puesto a mano — se
 *    reconoce "a mano" porque esas fotos siempre tienen `deviceId` real
 *    (subidas desde un iPhone/iPad concreto, ver POST /me/media); un
 *    fotograma automático se graba SIEMPRE con `deviceId: null`, así que
 *    "hay una LATERAL con deviceId no-null" es la señal inequívoca de
 *    "no tocar, esto es manual" — ni para crear ni para reemplazar. Los
 *    botones "Analizar"/"Reanalizar" de la app siguen intactos y con
 *    total prioridad: en cuanto el usuario toma su propia foto LATERAL,
 *    esta automatización deja esa tarjeta en paz para siempre (hasta que
 *    el usuario la borre).
 * 2) NUNCA reprocesa el mismo video de nuevo (ver `Hip.autoVideoFrameSourceUrl`
 *    en schema.prisma) — nunca dos veces el mismo video, solo cuando
 *    aparece uno nuevo/distinto.
 * 3) Asociación estricta HIP → VIDEO → ANÁLISIS: el fotograma se crea con
 *    `hipId` fijo desde el propio Hip que se está procesando y nunca se
 *    reutiliza entre Hips — mismo mecanismo de FK que ya usa cualquier
 *    otra foto de la app.
 * 4) Completamente silencioso: no hay ningún camino de UI que dispare
 *    esto — corre solo desde el barrido de Media server-side
 *    (mediaSweepService.ts). El único rastro visible para el usuario es
 *    el resultado ya aplicado (foto + score) la próxima vez que abra Análisis IA.
 * 5) No modifica en NADA el análisis de fotografías: usa exactamente el
 *    mismo `analyzeHipOnDemand` que ya usa el botón manual, sin tocar una
 *    sola línea de ese motor ni de su criterio de puntaje.
 */

/** Nunca más de esto por corrida del barrido — mismo espíritu que AnalysisBudget en rankingService.ts, protección de costo/estabilidad ante un caso inesperado (ej. una casa de ventas publicando video para cientos de Hips el mismo día). */
const MAX_AUTO_VIDEO_ANALYSES_PER_HIP_CALL = 8;

function catalogVideoUrls(media: CatalogMediaItem[]): string[] {
  return media.filter((m) => m.kind === "video" && !!m.url).map((m) => m.url);
}

/**
 * Único punto de entrada. Se llama desde mediaSweepService.ts apenas
 * confirma `mediaJson` nuevo para un Hip — recibe el Hip ya actualizado
 * (con el mediaJson fresco) y decide sola si hay trabajo real que hacer.
 * Nunca tira excepción hacia arriba (todo error queda contenido acá,
 * logueado) — un problema puntual de un Hip jamás debe interrumpir el
 * barrido de Media del resto del catálogo.
 */
export async function autoAnalyzeNewCatalogVideoIfNeeded(hip: {
  id: string;
  hipNumber: string;
  horseName: string | null;
  autoVideoFrameSourceUrl: string | null;
}, freshMedia: CatalogMediaItem[]): Promise<void> {
  try {
    const videoUrls = catalogVideoUrls(freshMedia);
    if (videoUrls.length === 0) return;

    // Idempotencia (regla 2): si el video que YA produjo el fotograma
    // vigente sigue estando entre los videos publicados hoy (en cualquier
    // posición, no solo el primero — importante: si el video prioritario
    // de siempre no se pudo leer con ffmpeg la última vez y se usó uno de
    // respaldo más abajo en la lista, comparar solo contra el primero
    // reprocesaría ese mismo respaldo en CADA barrido para siempre, sin
    // necesidad), no hay nada nuevo que hacer. Recién cuando el video que
    // se usó la última vez YA NO aparece en absoluto en la lista de hoy
    // (la casa de ventas lo reemplazó de verdad) se reintenta la lista
    // completa, en orden de prioridad, desde el principio.
    const normalizedToday = videoUrls.map(normalizeMediaUrl);
    if (hip.autoVideoFrameSourceUrl && normalizedToday.includes(hip.autoVideoFrameSourceUrl)) return;

    // Averigua, ANTES de gastar un solo ffmpeg/IA, si hay al menos una
    // organización para la que valga la pena (regla 1: nunca pisar una
    // LATERAL manual). Si ninguna organización califica, no se extrae
    // nada — y a propósito NO se actualiza `autoVideoFrameSourceUrl`, así
    // que si el usuario borra su foto manual más adelante, el próximo
    // barrido vuelve a evaluar este mismo Hip desde cero.
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

    // Extrae UN fotograma representativo, probando cada video publicado
    // en orden hasta que uno se pueda leer de verdad (Vimeo privado,
    // HLS-only, o un link roto simplemente se saltan).
    let frame: Buffer | null = null;
    let sourceUrl: string | null = null;
    for (const url of videoUrls.slice(0, MAX_AUTO_VIDEO_ANALYSES_PER_HIP_CALL)) {
      const extracted = await extractRepresentativeVideoFrame(url);
      if (extracted) {
        frame = extracted;
        sourceUrl = url;
        break;
      }
    }
    if (!frame || !sourceUrl) {
      console.log(`[auto-video-analysis] Hip ${hip.hipNumber}: ningún video publicado se pudo leer con ffmpeg todavía — se reintenta en el próximo barrido.`);
      return;
    }

    let appliedForAtLeastOneOrg = false;
    for (const org of eligible) {
      try {
        const user = await db.user.findFirst({ where: { organizationId: org.organizationId, role: "OWNER" } })
          ?? await db.user.findFirst({ where: { organizationId: org.organizationId } });
        if (!user) continue;

        // Regla "una foto = un registro" (mismo criterio que
        // addAIAnalysisPhoto en la app): si ya había un fotograma
        // automático anterior en esta tarjeta, se tombstona antes de
        // crear el nuevo.
        if (org.existingAutoAssetId) {
          await db.mediaAsset.update({ where: { id: org.existingAutoAssetId }, data: { deletedAt: new Date() } });
          if (org.existingAutoStorageKey) {
            deleteObject(org.existingAutoStorageKey).catch((err) => console.error(`[auto-video-analysis] No se pudo borrar el objeto viejo de R2:`, err));
          }
        }

        const contentType = "image/jpeg";
        const assetId = randomUUID();
        const storageKey = buildStorageKey({ organizationId: org.organizationId, hipId: hip.id, kind: "AI_ANALYSIS_PHOTO", mediaAssetId: assetId, contentType });
        await uploadObject(storageKey, frame, contentType);

        await db.mediaAsset.create({
          data: {
            id: assetId,
            userId: user.id,
            organizationId: org.organizationId,
            hipId: hip.id,
            deviceId: null, // Marca "generado automáticamente" — ver regla 1 arriba.
            kind: "AI_ANALYSIS_PHOTO",
            contentType,
            byteSize: frame.length,
            storageKey,
            conformationView: "lateral",
            uploadStatus: "PROCESSED",
          },
        });
        broadcastChange("media", null);

        await analyzeHipOnDemand(
          { id: hip.id, hipNumber: hip.hipNumber, horseName: hip.horseName },
          org.organizationId,
          undefined,
          "lateral" as ViewName
        );
        broadcastChange("analysis", null);
        appliedForAtLeastOneOrg = true;
        console.log(`[auto-video-analysis] Hip ${hip.hipNumber}: fotograma automático de video aplicado y analizado (org ${org.organizationId}).`);
      } catch (err) {
        // Un fallo de IA (referente faltante, error transitorio del
        // servidor, etc.) para UNA organización no debe impedir que otra
        // organización, ni el resto del barrido, sigan su curso — el MediaAsset
        // ya quedó guardado igual; el loop de reintento de 6s del
        // dispositivo (o el próximo barrido) puede terminar de analizarlo.
        console.error(`[auto-video-analysis] Hip ${hip.hipNumber}, org ${org.organizationId}: error aplicando análisis automático de video:`, err);
      }
    }

    if (appliedForAtLeastOneOrg) {
      await db.hip.update({ where: { id: hip.id }, data: { autoVideoFrameSourceUrl: normalizeMediaUrl(sourceUrl) } });
    }
  } catch (err) {
    console.error(`[auto-video-analysis] Hip ${hip.hipNumber}: error inesperado, se aborta sin romper el barrido:`, err);
  }
}
