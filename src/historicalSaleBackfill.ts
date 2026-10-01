import { db } from "./db";
import type { SaleHouse } from "@prisma/client";
import { clientFor } from "./saleHouses/registry";
import { consignorBaseName } from "./catalogNames";
import { rebuildSaleHistoryForHip } from "./saleHistoryService";
import { getSaleLifecycleStatus } from "./activeSaleService";

/**
 * Historial de Ventas — relleno de ventas ANTERIORES (2026-09-30, pedido
 * de Ramon: "los caballos que están en Fasig-Tipton, si han pasado por
 * alguna venta... también para OBS October").
 *
 * La app solo conserva las ventas que ella misma siguió. Para saber si un
 * yearling de hoy ya pasó antes por una venta hacen falta también las que
 * ocurrieron antes de que la app las siguiera (destetes de noviembre 2025,
 * ventas de enero/febrero 2026, July 2026, digitales). Se importan UNA
 * sola vez, como ventas INACTIVAS (isActive=false):
 *   - nunca aparecen en la lista de ventas de la app (GET /sales filtra
 *     isActive), ni en Buscar, ni en ningún job nocturno (todos exigen
 *     isActive) — cero trabajo repetido, cero memoria en ventas pasadas;
 *   - solo se guarda lo necesario para identificar al caballo y su
 *     resultado (padre, madre, sexo, nacimiento, consignor, resultado):
 *     sin fotos, videos, análisis ni PDFs.
 * Después se recalcula el historial de las ventas próximas/en curso con
 * las reglas estrictas de saleHistoryService (padre + madre + mismo año
 * de nacimiento + sexo compatible).
 */
interface HistoricalSource {
  house: SaleHouse;
  externalSaleId: string;
  name: string;
  startDate: string; // YYYY-MM-DD
}

const SOURCES: HistoricalSource[] = [
  { house: "KEENELAND", externalSaleId: "4", name: "November Breeding Stock Sale 2025", startDate: "2025-11-03" },
  { house: "KEENELAND", externalSaleId: "6", name: "January Horses of All Ages Sale 2026", startDate: "2026-01-12" },
  { house: "FASIG_TIPTON", externalSaleId: "288", name: "The November Sale 2025", startDate: "2025-11-03" },
  { house: "FASIG_TIPTON", externalSaleId: "291", name: "Fasig-Tipton Digital (Dic 2025)", startDate: "2025-12-04" },
  { house: "FASIG_TIPTON", externalSaleId: "292", name: "Fasig-Tipton Digital (Ene 2026)", startDate: "2026-01-15" },
  { house: "FASIG_TIPTON", externalSaleId: "293", name: "Kentucky Winter Mixed 2026", startDate: "2026-02-09" },
  { house: "FASIG_TIPTON", externalSaleId: "294", name: "Fasig-Tipton Digital (Feb 2026)", startDate: "2026-02-19" },
  { house: "FASIG_TIPTON", externalSaleId: "295", name: "Fasig-Tipton Digital (Mar 2026)", startDate: "2026-03-19" },
  { house: "FASIG_TIPTON", externalSaleId: "296", name: "Fasig-Tipton Digital (Abr 2026)", startDate: "2026-04-16" },
  { house: "FASIG_TIPTON", externalSaleId: "298", name: "Fasig-Tipton Digital (May 2026)", startDate: "2026-05-07" },
  { house: "FASIG_TIPTON", externalSaleId: "306", name: "Fasig-Tipton Digital (Jun 2026)", startDate: "2026-06-25" },
  { house: "FASIG_TIPTON", externalSaleId: "305", name: "The July Sale 2026", startDate: "2026-07-14" },
  { house: "FASIG_TIPTON", externalSaleId: "313", name: "Fasig-Tipton Digital (Jul 2026)", startDate: "2026-07-23" },
  { house: "FASIG_TIPTON", externalSaleId: "316", name: "Fasig-Tipton Digital (Ago 2026)", startDate: "2026-08-24" },
  { house: "OBS", externalSaleId: "147", name: "OBS Winter Mixed Sale 2026", startDate: "2026-01-27" },
];

async function importSource(source: HistoricalSource): Promise<number> {
  const existing = await db.sale.findUnique({
    where: { house_externalSaleId: { house: source.house, externalSaleId: source.externalSaleId } },
    include: { _count: { select: { hips: true } } },
  });
  // Una venta que la app ya sigue (activa) o ya importada antes: no se toca.
  if (existing && (existing.isActive || existing._count.hips > 0)) return 0;

  const hips = await clientFor(source.house).fetchCatalog(source.externalSaleId);
  if (hips.length === 0) return 0;
  const startDate = new Date(`${source.startDate}T16:00:00Z`);
  const sale = existing
    ? existing
    : await db.sale.create({
        data: {
          house: source.house,
          externalSaleId: source.externalSaleId,
          name: source.name,
          startDate,
          endDate: startDate,
          isActive: false,
          catalogAccess: "FULL",
          lastCatalogCheckAt: new Date(),
        },
      });

  let saved = 0;
  for (const hip of hips) {
    if (!hip.sire || !hip.dam) continue;
    const foalYear = hip.foalYear ?? (hip.foalingDate ? hip.foalingDate.getUTCFullYear() : undefined);
    const data = {
      horseName: hip.horseName,
      sex: hip.sex,
      consignor: hip.consignor,
      sire: hip.sire,
      dam: hip.dam,
      damSire: hip.damSire,
      foalYear,
      foalingDate: hip.foalingDate,
      color: hip.color,
      bredState: hip.bredState,
      consignorBase: hip.consignorBase ?? consignorBaseName(hip.consignor) ?? undefined,
      saleResultJson: (hip.saleResult ?? null) as unknown as object,
      lastCatalogSyncAt: new Date(),
    };
    await db.hip.upsert({
      where: { saleId_hipNumber: { saleId: sale.id, hipNumber: hip.hipNumber } },
      create: { saleId: sale.id, hipNumber: hip.hipNumber, mediaJson: [], ...data },
      update: data,
    });
    saved += 1;
  }
  return saved;
}

let running = false;

export async function backfillHistoricalSales(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let imported = 0;
    for (const source of SOURCES) {
      try {
        const count = await importSource(source);
        if (count > 0) {
          imported += count;
          console.log(`[sale-history][backfill] "${source.name}" (${source.house}/${source.externalSaleId}): ${count} HIPs guardados como historial.`);
        }
      } catch (err) {
        console.error(`[sale-history][backfill] Error importando "${source.name}" (${source.house}/${source.externalSaleId}):`, err);
      }
    }

    // Recalcular el historial de las ventas próximas / en curso (nunca de
    // las finalizadas). Solo si se importó algo nuevo o si alguna venta
    // próxima todavía no fue recalculada con las reglas estrictas.
    const targets = (
      await db.sale.findMany({ where: { isActive: true, catalogAccess: { in: ["FULL", "MANUAL_CSV"] } } })
    ).filter((sale) => getSaleLifecycleStatus(sale as unknown as { startDate: Date | null; endDate: Date | null }) !== "COMPLETED");
    for (const sale of targets) {
      // Ya recalculada con las reglas v2 y sin fuentes nuevas: nada que hacer.
      const legacy = await db.horseSaleHistory.count({
        where: { source: "INTERNAL_HIP", hip: { saleId: sale.id }, NOT: { matchBasis: { path: ["rule"], equals: "v2" } } },
      });
      const v2 = await db.horseSaleHistory.count({
        where: { source: "INTERNAL_HIP", hip: { saleId: sale.id }, matchBasis: { path: ["rule"], equals: "v2" } },
      });
      if (imported === 0 && legacy === 0 && v2 > 0) continue;
      const hips = await db.hip.findMany({ where: { saleId: sale.id, sire: { not: null }, dam: { not: null } }, select: { id: true } });
      for (const hip of hips) {
        try {
          await rebuildSaleHistoryForHip(hip.id);
        } catch (err) {
          console.error(`[sale-history][backfill] Error recalculando historial de un HIP de "${sale.name}":`, err);
        }
      }
      const withHistory = await db.horseSaleHistory.groupBy({ by: ["hipId"], where: { hip: { saleId: sale.id } } });
      console.log(`[sale-history][backfill] "${sale.name}": ${withHistory.length} de ${hips.length} HIPs con historial.`);
    }
  } finally {
    running = false;
  }
}
