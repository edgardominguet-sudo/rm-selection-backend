import { db } from "./db";
import { clientFor } from "./saleHouses/registry";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { CatalogMediaItem, CatalogNotYetPublishedError } from "./types";
import { autoAnalyzeNewCatalogVideoIfNeeded } from "./analysis/autoVideoAnalysis";
import { autoAnalyzeNewCatalogPhotoIfNeeded, AutoPhotoAnalysisOutcome } from "./analysis/autoPhotoAnalysis";
import { runWithConcurrencyLimit } from "./util/concurrencyPool";
import { config } from "./config";

/**
 * Barrido de Media — pieza única y centralizada de detección/descarga de
 * fotos y video de catálogo (2026-08-14, a pedido explícito; reforzado
 * 2026-08-15 tras confirmar que el cliente todavía disparaba una
 * comparación contra el servidor en cada entrada a una venta — ver
 * HipListViewModel.swift, ya corregido).
 *
 * Completamente separado del scheduler de ranking/análisis (scheduler.ts,
 * cada 5 min: sigue exactamente igual, precio/comprador/RNA en vivo el día
 * de la venta lo necesita seguir chequeando seguido) y del de
 * descubrimiento de ventas nuevas (cada 6h). Este barrido tiene un solo
 * propósito, acotado: revisar si apareció una foto o video NUEVO para
 * algún Hip ya registrado, y guardarlo. Nunca decide ranking, nunca
 * dispara análisis IA, nunca toca precio/sesión.
 *
 * ÚNICO disparador automático: cron "0 3 * * *" en scheduler.ts (una vez
 * al día). El único OTRO disparador válido es una corrida MANUAL explícita
 * (POST /api/v1/sales/:saleId/media-sweep, ver routes.ts) para diagnóstico
 * puntual — nunca la interfaz normal de navegación. Cada corrida (de
 * cualquiera de los dos orígenes) queda registrada en MediaSweepRun (ver
 * schema.prisma) con contadores reales, para poder responder "¿cuándo
 * corrió por última vez, qué encontró?" sin depender de logs de Railway.
 *
 * SOLO cubre ventas catalogAccess=FULL (Keeneland, Fasig-Tipton con ID
 * numérico real conocido): son las únicas con una API en vivo legítima
 * contra la que volver a chequear. Ventas MANUAL_CSV (ej. Fasig-Tipton — New
 * York Bred Yearlings, importada por CSV porque Fasig-Tipton no expone
 * públicamente el ID numérico de esa venta — ver
 * saleHouses/discovery/fasigTiptonDiscovery.ts) NO tienen ningún camino
 * automático legítimo para volver a chequear fotos/video: no se inventa
 * ninguno acá. Si en algún momento se carga el ID real (mismo mecanismo que
 * ya existe para Saratoga, vía POST /sales) o se sube un CSV nuevo con
 * columnas de foto/video, esa venta empieza a beneficiarse de este barrido
 * (o del CSV) sin ningún cambio de código.
 */

/** Resumen de una venta puntual dentro de una corrida — lo que se guarda en MediaSweepRun.detailsJson. */
export interface MediaSweepSaleDetail {
  saleId: string;
  saleName: string;
  house: string;
  /** Hips ya registrados en RM Selection para esta venta, comparados contra el catálogo en vivo. */
  hipsReviewed: number;
  /** De esos, cuántos tenían foto/video distinto a lo ya guardado (se actualizaron). */
  hipsWithNewMedia: number;
  /** Fotos + videos nuevos encontrados en total (no Hips — recursos individuales), sumando solo lo que no estaba ya guardado. */
  resourcesFound: number;
  photosFound: number;
  videosFound: number;
  /**
   * Hips cuyo catálogo en vivo (fresco, recién descargado) no trae NINGUNA
   * foto/video todavía — es decir, la casa de ventas simplemente no
   * publicó media para ese Hip puntual (no es un error de nuestro
   * extractor: el propio catálogo de la casa viene sin nada ahí). Ver
   * punto 4 de la tarea (2026-08-15): distinguir "no publicado" de "no
   * encontrado por nuestro extractor". Para Fasig-Tipton y Keeneland, la
   * extracción de media es un campo directo de la respuesta de catálogo
   * (no un scraping por-Hip aparte que pueda fallar de forma
   * independiente) — así que si un Hip aparece en el catálogo pero sin
   * media, la única explicación real es que la casa todavía no la
   * publicó para ese Hip. Si `fetchCatalog` completo falla (red, JSON
   * inválido, etc.), eso NO se cuenta acá — cae en `errors` de todo el
   * barrido, y ahí sí puede tratarse de un problema de nuestro lado.
   */
  hipsWithoutMediaYet: number;
  /**
   * Resultado del análisis automático de fotos (autoPhotoAnalysis.ts)
   * para ESTA venta en ESTA corrida — pedido explícito de Ramon
   * (2026-09-10) de poder confirmar, corrida por corrida, cuántas fotos
   * pendientes encontró, cuántas analizó correctamente y cuántas
   * fallaron, sin depender de contar líneas de log a mano.
   */
  autoPhotoAnalysis: {
    /** Hips con al menos una foto publicada — el universo evaluado. */
    photoHipsEvaluated: number;
    /** Nueva tarjeta LATERAL creada y analizada con éxito. */
    applied: number;
    /** Ya estaba procesado de antes (idempotencia) — nada que hacer. */
    alreadyProcessed: number;
    /** El motor funcionó, pero ninguna foto publicada es LATERAL con confianza suficiente — resultado válido, no es un fallo. */
    noLateralCandidate: number;
    /** Todas las organizaciones ya tienen una LATERAL puesta a mano — nada que tocar. */
    noEligibleOrg: number;
    /** Fallo técnico real (descarga, IA, subida, base de datos) — se reintentará, sujeto al tope de reintentos. */
    failed: number;
    /** Tope de reintentos técnicos consecutivos alcanzado — dejado de lado hasta que cambie la foto o se revise a mano. */
    retriesExhausted: number;
  };
}

export interface MediaSweepSummary {
  runId: string;
  salesChecked: number;
  salesSkipped: number;
  hipsReviewed: number;
  hipsWithNewMedia: number;
  resourcesFound: number;
  errors: string[];
  saleDetails: MediaSweepSaleDetail[];
}

function countNewResources(fresh: CatalogMediaItem[], stored: CatalogMediaItem[]): { photos: number; videos: number } {
  const storedUrls = new Set(stored.map((m) => m.url));
  const newItems = fresh.filter((m) => !storedUrls.has(m.url));
  return {
    photos: newItems.filter((m) => m.kind === "photo").length,
    videos: newItems.filter((m) => m.kind === "video").length,
  };
}

/**
 * @param opts.trigger "scheduled" (cron 3am) o "manual" (endpoint de
 *   diagnóstico). Se persiste tal cual en MediaSweepRun.trigger.
 * @param opts.saleId  Si se pasa, la corrida se acota a ESA sola venta
 *   (usado por el endpoint manual — nunca hace falta barrer todas las
 *   ventas activas para probar una sola). Si se omite, se procesan todas
 *   las ventas activas con catalogAccess=FULL (comportamiento del cron).
 */
export async function runNightlyMediaSweep(opts: { trigger: "scheduled" | "manual"; saleId?: string } = { trigger: "scheduled" }): Promise<MediaSweepSummary> {
  const run = await db.mediaSweepRun.create({
    data: { trigger: opts.trigger, status: "running" },
  });

  const errors: string[] = [];
  const saleDetails: MediaSweepSaleDetail[] = [];
  let salesChecked = 0;
  let hipsReviewedTotal = 0;
  let hipsWithNewMediaTotal = 0;
  let resourcesFoundTotal = 0;

  try {
    const sales = await db.sale.findMany({
      where: opts.saleId
        ? { id: opts.saleId }
        : { isActive: true, catalogAccess: "FULL" },
    });

    for (const sale of sales) {
      // Si se pidió una venta puntual que no es FULL (ej. MANUAL_CSV, sin
      // ningún camino legítimo de re-chequeo en vivo), se informa como
      // error claro en vez de intentar algo que no puede funcionar — así
      // una corrida manual mal apuntada no se confunde con "no encontró
      // nada".
      if (sale.catalogAccess !== "FULL") {
        errors.push(
          `${sale.name}: catalogAccess=${sale.catalogAccess} — esta venta no tiene una API de catálogo en vivo contra la que re-chequear (ver mediaSweepService.ts). Necesita un CSV nuevo o que se cargue su ID real.`
        );
        continue;
      }
      try {
        const client = clientFor(sale.house);
        const hipCountBeforeSync = await db.hip.count({ where: { saleId: sale.id } });
        const hips = await client.fetchCatalog(sale.externalSaleId, {
          name: sale.name,
          startDate: sale.startDate,
          hipCountBeforeSync,
        });
        salesChecked += 1;

        const existing = await db.hip.findMany({
          where: { saleId: sale.id },
          select: { id: true, hipNumber: true, horseName: true, mediaJson: true, autoVideoFrameSourceUrl: true, autoLateralPhotoSourceUrl: true, autoLateralPhotoFailedAttempts: true, autoLateralPhotoLastAttemptedFingerprint: true },
        });
        const existingByNumber = new Map(existing.map((h) => [h.hipNumber, h]));

        let hipsReviewed = 0;
        let hipsWithNewMedia = 0;
        let hipsWithoutMediaYet = 0;
        let photosFound = 0;
        let videosFound = 0;

        // Hips con foto pendiente de evaluar en esta corrida (ver bloque
        // de análisis automático de fotos más abajo) — se acumulan acá y
        // se procesan TODOS al final del loop, con concurrencia limitada
        // (regla explícita de Ramon 2026-09-10: "procesar TODAS las
        // fotos pendientes en esa misma corrida", ya no un tope fijo de
        // cantidad por corrida).
        type PhotoWorkItem = {
          hip: {
            id: string;
            hipNumber: string;
            horseName: string | null;
            autoLateralPhotoSourceUrl: string | null;
            autoLateralPhotoFailedAttempts: number;
            autoLateralPhotoLastAttemptedFingerprint: string | null;
          };
          freshMedia: CatalogMediaItem[];
        };
        const photoWorkItems: PhotoWorkItem[] = [];

        for (const hip of hips) {
          const row = existingByNumber.get(hip.hipNumber);
          // Hip todavía no registrado en esta venta: no es trabajo de este
          // barrido crearlo (eso es catálogo completo, ver syncCatalog) —
          // se salta, a propósito, "Hips ya registrados" es el pedido
          // explícito. No cuenta como "revisado" (nunca se comparó nada).
          if (!row) continue;
          hipsReviewed += 1;

          const freshMedia = hip.media ?? [];
          if (freshMedia.length === 0) hipsWithoutMediaYet += 1;

          const storedMedia = (Array.isArray(row.mediaJson) ? row.mediaJson : []) as unknown as CatalogMediaItem[];
          const mediaChanged = mediaFingerprint(freshMedia) !== mediaFingerprint(storedMedia);

          if (mediaChanged) {
            const { photos, videos } = countNewResources(freshMedia, storedMedia);
            photosFound += photos;
            videosFound += videos;

            await db.hip.update({
              where: { id: row.id },
              data: { mediaJson: freshMedia as unknown as object },
            });
            hipsWithNewMedia += 1;
          }

          // ANÁLISIS AUTOMÁTICO Y SILENCIOSO DE VIDEO (2026-09-10, a
          // pedido explícito de Ramon) — ESTE es el punto exacto en el
          // que "RM Selection detecta que la casa de venta publicó/cargó
          // un nuevo video". IMPORTANTE (bug real encontrado en la prueba
          // de punta a punta del mismo 2026-09-10, contra Keeneland
          // September Yearling Sale en producción, Hips 3181/3740/3892/
          // 3896/3912/3917/3958): este chequeo NO puede quedar adentro
          // del `if (mediaChanged)` de arriba. Motivo real observado: la
          // casa de venta publica un video, `mediaChanged` es true UNA
          // sola vez y `mediaJson` se guarda ya en esa misma corrida —
          // pero si en ESE momento el video todavía no se puede leer con
          // ffmpeg (Vimeo recién publicado, todavía transcodificando —
          // pasó con los 7 Hips de la prueba), el mensaje de log decía
          // "se reintenta en el próximo barrido" pero eso era falso: como
          // `mediaJson` ya quedó igual al catálogo fresco, el PRÓXIMO
          // barrido ya no ve ningún cambio (`mediaChanged` da false) y el
          // Hip queda atascado para siempre sin analizar, aunque el video
          // ya esté disponible más tarde. Fix: evaluar el video pendiente
          // en CADA barrido, no solo cuando el catálogo cambió esta
          // corrida — `autoAnalyzeNewCatalogVideoIfNeeded` ya es
          // idempotente por su cuenta (compara `autoVideoFrameSourceUrl`
          // contra los videos publicados hoy), así que llamarla de más es
          // segura y barata: para un Hip ya procesado y sin cambios,
          // vuelve casi al instante sin tocar la base de datos ni ffmpeg.
          // Contenido en su propio try/catch: un problema acá NUNCA debe
          // impedir que el resto del barrido de Media (fotos, otros Hips,
          // otras ventas) siga su curso normal.
          const hasPendingVideo = freshMedia.some((m) => m.kind === "video" && !!m.url);
          if (hasPendingVideo) {
            try {
              await autoAnalyzeNewCatalogVideoIfNeeded(
                { id: row.id, hipNumber: row.hipNumber, horseName: row.horseName, autoVideoFrameSourceUrl: row.autoVideoFrameSourceUrl },
                freshMedia
              );
            } catch (err) {
              console.error(`[media-sweep] Hip ${row.hipNumber}: error en análisis automático de video:`, err);
            }
          }

          // ANÁLISIS AUTOMÁTICO Y SILENCIOSO DE FOTOS (2026-09-10, a
          // pedido explícito de Ramon: "detección automática de nuevas
          // fotos en Media → clasificación para identificar cuál es la
          // foto LATERAL → envío automático al Análisis IA Lateral →
          // análisis → guardado permanente del resultado en el HIP
          // correspondiente", ajustado el mismo día para procesar TODO
          // lo pendiente por corrida, en paralelo controlado — ver bloque
          // de concurrencia después de este loop). Mecanismo
          // COMPLETAMENTE INDEPENDIENTE del de video de arriba — pedido
          // explícito: "no quiero usar el mecanismo de video para esta
          // función" — ninguno de los dos reutiliza ni pisa el trabajo
          // del otro, y este bloque nunca analiza video ni extrae
          // fotogramas (ver analysis/autoPhotoAnalysis.ts). Acá SOLO se
          // recolecta el Hip como candidato — el trabajo real (que
          // incluye las llamadas a la IA) se hace después del loop, con
          // concurrencia limitada, para no serializar miles de
          // clasificaciones una por una. Mismo criterio que el bloque de
          // video: se evalúa en CADA barrido, no solo cuando `mediaJson`
          // cambió esta corrida — `autoAnalyzeNewCatalogPhotoIfNeeded` ya
          // es idempotente por su cuenta, así que incluir de más acá es
          // seguro y barato (la función resuelve casi al instante para un
          // Hip ya procesado, sin tocar la base de datos de más).
          if (freshMedia.some((m) => m.kind === "photo" && !!m.url)) {
            photoWorkItems.push({
              hip: {
                id: row.id,
                hipNumber: row.hipNumber,
                horseName: row.horseName,
                autoLateralPhotoSourceUrl: row.autoLateralPhotoSourceUrl,
                autoLateralPhotoFailedAttempts: row.autoLateralPhotoFailedAttempts,
                autoLateralPhotoLastAttemptedFingerprint: row.autoLateralPhotoLastAttemptedFingerprint,
              },
              freshMedia,
            });
          }
        }

        // Procesa TODOS los Hips con foto pendiente de esta venta, con
        // concurrencia limitada (config.autoPhotoAnalysisConcurrency,
        // ver config.ts para el razonamiento de seguridad completo —
        // verificado contra las métricas reales de Railway y el patrón
        // de reintento con backoff ya existente antes de habilitar
        // esto). Ya NO hay tope de cantidad por corrida — pedido
        // explícito de Ramon (2026-09-10): "si hay 10, 50, 200 o 500
        // fotos nuevas pendientes, debe procesar TODAS las fotos
        // pendientes en esa misma corrida". La protección de
        // costo/estabilidad pasa por la concurrencia acotada + el tope
        // de reintentos técnicos consecutivos dentro de
        // autoAnalyzeNewCatalogPhotoIfNeeded (regla 7, ver ese archivo),
        // no por dejar Hips sin evaluar.
        const autoPhotoAnalysis = {
          photoHipsEvaluated: photoWorkItems.length,
          applied: 0,
          alreadyProcessed: 0,
          noLateralCandidate: 0,
          noEligibleOrg: 0,
          failed: 0,
          retriesExhausted: 0,
        };
        await runWithConcurrencyLimit(photoWorkItems, config.autoPhotoAnalysisConcurrency, async (item) => {
          let outcome: AutoPhotoAnalysisOutcome;
          try {
            outcome = await autoAnalyzeNewCatalogPhotoIfNeeded(item.hip, item.freshMedia);
          } catch (err) {
            // autoAnalyzeNewCatalogPhotoIfNeeded ya nunca debería tirar
            // (todo error queda contenido adentro) — este catch es un
            // último cinturón de seguridad para que un fallo realmente
            // inesperado acá NUNCA tumbe el resto del pool de concurrencia.
            console.error(`[media-sweep] Hip ${item.hip.hipNumber}: error en análisis automático de foto:`, err);
            outcome = "failed";
          }
          switch (outcome) {
            case "applied":
              autoPhotoAnalysis.applied += 1;
              break;
            case "already_processed":
              autoPhotoAnalysis.alreadyProcessed += 1;
              break;
            case "no_lateral_candidate":
              autoPhotoAnalysis.noLateralCandidate += 1;
              break;
            case "no_eligible_org":
              autoPhotoAnalysis.noEligibleOrg += 1;
              break;
            case "retries_exhausted":
              autoPhotoAnalysis.retriesExhausted += 1;
              break;
            case "failed":
              autoPhotoAnalysis.failed += 1;
              break;
            case "no_photo":
              // No debería pasar acá (solo se agregan Hips CON foto a
              // photoWorkItems) — no se cuenta en ningún casillero
              // específico, no afecta el resumen.
              break;
          }
        });

        hipsReviewedTotal += hipsReviewed;
        hipsWithNewMediaTotal += hipsWithNewMedia;
        resourcesFoundTotal += photosFound + videosFound;

        saleDetails.push({
          saleId: sale.id,
          saleName: sale.name,
          house: sale.house,
          hipsReviewed,
          hipsWithNewMedia,
          resourcesFound: photosFound + videosFound,
          photosFound,
          videosFound,
          hipsWithoutMediaYet,
          autoPhotoAnalysis,
        });
      } catch (err) {
        if (err instanceof CatalogNotYetPublishedError) {
          // Estado normal de espera, no un error — no ensucia el resumen,
          // pero sí queda como detalle de venta con 0 revisados para que
          // quede visible que se intentó.
          saleDetails.push({
            saleId: sale.id,
            saleName: sale.name,
            house: sale.house,
            hipsReviewed: 0,
            hipsWithNewMedia: 0,
            resourcesFound: 0,
            photosFound: 0,
            videosFound: 0,
            hipsWithoutMediaYet: 0,
            autoPhotoAnalysis: {
              photoHipsEvaluated: 0,
              applied: 0,
              alreadyProcessed: 0,
              noLateralCandidate: 0,
              noEligibleOrg: 0,
              failed: 0,
              retriesExhausted: 0,
            },
          });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[media-sweep] Error revisando "${sale.name}":`, err);
        errors.push(`${sale.name}: ${message}`);
      }
    }

    const salesSkipped = opts.saleId
      ? 0
      : await db.sale.count({ where: { isActive: true, catalogAccess: { not: "FULL" } } });

    await db.mediaSweepRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: errors.length > 0 && salesChecked === 0 ? "failed" : "completed",
        salesChecked,
        salesSkipped,
        hipsReviewed: hipsReviewedTotal,
        hipsWithNewMedia: hipsWithNewMediaTotal,
        resourcesFound: resourcesFoundTotal,
        errorMessage: errors.length > 0 ? errors.join(" | ") : null,
        detailsJson: saleDetails as unknown as object,
      },
    });

    return {
      runId: run.id,
      salesChecked,
      salesSkipped,
      hipsReviewed: hipsReviewedTotal,
      hipsWithNewMedia: hipsWithNewMediaTotal,
      resourcesFound: resourcesFoundTotal,
      errors,
      saleDetails,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.mediaSweepRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: "failed", errorMessage: message },
    });
    throw err;
  }
}
