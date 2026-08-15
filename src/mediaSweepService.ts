import { db } from "./db";
import { clientFor } from "./saleHouses/registry";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { CatalogMediaItem, CatalogNotYetPublishedError } from "./types";

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
          select: { id: true, hipNumber: true, mediaJson: true },
        });
        const existingByNumber = new Map(existing.map((h) => [h.hipNumber, h]));

        let hipsReviewed = 0;
        let hipsWithNewMedia = 0;
        let hipsWithoutMediaYet = 0;
        let photosFound = 0;
        let videosFound = 0;

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
          if (mediaFingerprint(freshMedia) === mediaFingerprint(storedMedia)) continue;

          const { photos, videos } = countNewResources(freshMedia, storedMedia);
          photosFound += photos;
          videosFound += videos;

          await db.hip.update({
            where: { id: row.id },
            data: { mediaJson: freshMedia as unknown as object },
          });
          hipsWithNewMedia += 1;
        }

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
