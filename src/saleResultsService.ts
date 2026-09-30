import { db } from "./db";
import type { Sale } from "@prisma/client";
import { getSaleLifecycleStatus } from "./activeSaleService";

/**
 * "Resultados" (2026-09-30, pedido de Ramon: "una ventana de resultados de
 * las ventas, que uno pueda buscarlo por comprador, consignor, RNA, etc." —
 * con la lista completa del HIP 1 al último y el buscador arriba).
 *
 * SOLO LECTURA: devuelve lo que ya está guardado en la base para cada HIP
 * de UNA venta (catálogo + Hip.saleResultJson, que la sincronización de
 * precios en vivo ya mantiene al día cada 10 minutos mientras la venta está
 * en curso). No llama a ninguna casa de ventas, no descarga nada, no
 * dispara ningún análisis — sirve igual para ventas finalizadas sin gastar
 * nada. El cálculo de estado (vendido/RNA/PS/OUT/por salir) y los totales
 * los hace la app con el mismo `SaleResult.outcome` que ya usa en toda la
 * app, así nunca hay dos criterios distintos para lo mismo.
 */
export interface SaleResultRow {
  hipNumber: string;
  horseName: string | null;
  sex: string | null;
  color: string | null;
  sire: string | null;
  dam: string | null;
  damSire: string | null;
  consignor: string | null;
  day: string | null; // "YYYY-MM-DD" (día calendario en Kentucky/ET)
  priceRaw: string | null;
  purchaser: string | null;
  soldAsCode: string | null;
}

export interface SaleResultsResponse {
  saleName: string;
  status: "UPCOMING" | "ACTIVE" | "COMPLETED";
  generatedAt: string;
  rows: SaleResultRow[];
}

const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function hipSortKey(hipNumber: string): [number, string] {
  const n = parseInt(hipNumber, 10);
  return [Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n, hipNumber];
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export async function getSaleResults(sale: Sale): Promise<SaleResultsResponse> {
  const hips = await db.hip.findMany({
    where: { saleId: sale.id },
    select: {
      hipNumber: true,
      horseName: true,
      sex: true,
      color: true,
      sire: true,
      dam: true,
      damSire: true,
      consignor: true,
      consignorBase: true,
      sessionDate: true,
      saleResultJson: true,
    },
  });

  const rows: SaleResultRow[] = hips.map((hip) => {
    const result = (hip.saleResultJson ?? null) as Record<string, unknown> | null;
    return {
      hipNumber: hip.hipNumber,
      horseName: hip.horseName ?? null,
      sex: hip.sex ?? null,
      color: hip.color ?? null,
      sire: hip.sire ?? null,
      dam: hip.dam ?? null,
      damSire: hip.damSire ?? null,
      // Mismo criterio que Buscar: un solo consignor, sin las variantes
      // "…, Agent" (ver catalogNames / consignorBase).
      consignor: hip.consignorBase ?? hip.consignor ?? null,
      day: hip.sessionDate ? etDay.format(hip.sessionDate) : null,
      priceRaw: result ? str(result.priceRaw) : null,
      purchaser: result ? str(result.purchaser) : null,
      soldAsCode: result ? str(result.soldAsCode) : null,
    };
  });

  rows.sort((a, b) => {
    const [na, sa] = hipSortKey(a.hipNumber);
    const [nb, sb] = hipSortKey(b.hipNumber);
    return na !== nb ? na - nb : sa.localeCompare(sb);
  });

  return {
    saleName: sale.name,
    status: getSaleLifecycleStatus(sale as unknown as { startDate: Date | null; endDate: Date | null }),
    generatedAt: new Date().toISOString(),
    rows,
  };
}
