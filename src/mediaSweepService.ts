import { db } from "./db";
import { clientFor } from "./saleHouses/registry";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { CatalogMediaItem, CatalogNotYetPublishedError } from "./types";

/**
 * Barrido NOCTURNO de Media (2026-08-14, a pedido explícito) — completamente
 * separado del scheduler de ranking/análisis (scheduler.ts, cada 5 min):
 * ese sigue existiendo tal cual estaba (precio/comprador/RNA en vivo el día
 * de la venta lo necesita seguir chequeando seguido, no se tocó). Este
 * barrido tiene un solo propósito, acotado: una vez al día, revisar si
 * apareció una foto o video NUEVO para algún Hip ya registrado, y guardarlo.
 * Nunca decide ranking, nunca dispara análisis IA, nunca toca precio/sesión.
 *
 * Por qué separado del polling de catálogo existente: antes de esto, la
 * búsqueda de fotos/video "nuevas" corría del lado del DISPOSITIVO (ver
 * HipListViewModel.syncMediaInBackground, ahora sin disparador automático)
 * cada 60-75 segundos mientras el usuario tenía una pantalla de venta
 * abierta — más grave todavía: esa búsqueda cliente NUNCA podía encontrar
 * nada nuevo de verdad, porque los 3 data services de iOS
 * (FasigTiptonHipDataService/KeenelandHipDataService/
 * BackendCatalogHipDataService) cachean su catálogo para siempre por
 * instancia — o sea, todo ese trabajo repetido (fetch + parseo + guardado
 * en SwiftData de cientos de Hips, en el hilo principal) no encontraba
 * nunca nada, y es la causa más probable del problema de "no responde al
 * primer toque" reportado. Ver auditoría 2026-08-14.
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
export interface MediaSweepSummary {
  salesChecked: number;
  salesSkipped: number;
  hipsWithNewMedia: number;
  errors: string[];
}

export async function runNightlyMediaSweep(): Promise<MediaSweepSummary> {
  const summary: MediaSweepSummary = { salesChecked: 0, salesSkipped: 0, hipsWithNewMedia: 0, errors: [] };

  const sales = await db.sale.findMany({ where: { isActive: true, catalogAccess: "FULL" } });

  for (const sale of sales) {
    try {
      const client = clientFor(sale.house);
      const hipCountBeforeSync = await db.hip.count({ where: { saleId: sale.id } });
      const hips = await client.fetchCatalog(sale.externalSaleId, {
        name: sale.name,
        startDate: sale.startDate,
        hipCountBeforeSync,
      });
      summary.salesChecked += 1;

      const existing = await db.hip.findMany({
        where: { saleId: sale.id },
        select: { id: true, hipNumber: true, mediaJson: true },
      });
      const existingByNumber = new Map(existing.map((h) => [h.hipNumber, h]));

      for (const hip of hips) {
        const row = existingByNumber.get(hip.hipNumber);
        // Hip todavía no registrado en esta venta: no es trabajo de este
        // barrido crearlo (eso es catálogo completo, ver syncCatalog) — se
        // salta, a propósito, "Hips ya registrados" es el pedido explícito.
        if (!row) continue;

        const freshMedia = hip.media ?? [];
        const storedMedia = (Array.isArray(row.mediaJson) ? row.mediaJson : []) as unknown as CatalogMediaItem[];
        if (mediaFingerprint(freshMedia) === mediaFingerprint(storedMedia)) continue;

        await db.hip.update({
          where: { id: row.id },
          data: { mediaJson: freshMedia as unknown as object },
        });
        summary.hipsWithNewMedia += 1;
      }
    } catch (err) {
      if (err instanceof CatalogNotYetPublishedError) {
        // Estado normal de espera, no un error — no ensucia el resumen.
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[media-sweep] Error revisando "${sale.name}":`, err);
      summary.errors.push(`${sale.name}: ${message}`);
    }
  }

  const skipped = await db.sale.count({ where: { isActive: true, catalogAccess: { not: "FULL" } } });
  summary.salesSkipped = skipped;

  return summary;
}
