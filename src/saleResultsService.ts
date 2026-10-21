import { db } from "./db";
import type { Sale } from "@prisma/client";
import { getSaleLifecycleStatus } from "./activeSaleService";
import { rnaReserveAmountOf, saleStatusOf } from "./search/searchLogic";

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
  /** Monto de la reserva si es RNA (2026-10-06) — null si no hay dato. */
  rnaAmount: number | null;
  /** true = está en Favoritos del usuario (se muestra en verde). */
  isFavorite: boolean;
  /** Barn del catálogo (2026-10-20, Próximos favoritos al ring). */
  barn: string | null;
  /** Decisión del usuario: "Comprar" | "Revisar" | "Descartar" | null. */
  decision: string | null;
}

/** Ritmo real del ring HOY: minutos por lote, medido por el servidor. */
export interface RingPace {
  day: string;
  minutesPerLot: number;
  /** Lote (en orden de ring, sin retirados) del último HIP que ya salió. */
  lastLot: number;
  /** Cuándo se vio ese último lote por primera vez. */
  observedAt: string;
}

export interface SaleResultsResponse {
  saleName: string;
  status: "UPCOMING" | "ACTIVE" | "COMPLETED";
  generatedAt: string;
  rows: SaleResultRow[];
  ringPace: RingPace | null;
}

// ---------------------------------------------------------------------------
// Ritmo del ring (2026-10-20, Ramon: hora estimada de salida de cada
// favorito). Cada vez que se arma la lista (pedido de la app cada 2 min, y
// el ciclo de precios en vivo cada 10) se anota en qué lote va el ring y
// cuándo se vio por primera vez. Minutos por lote = tiempo / lotes entre la
// observación más vieja de los últimos 90 min y la más nueva. Solo memoria:
// tras un reinicio del servidor se recupera solo en ~20 min.
// ---------------------------------------------------------------------------
const paceObservations = new Map<string, Array<{ t: number; lot: number }>>();

function recordRingLot(key: string, lot: number, now: number) {
  const list = paceObservations.get(key) ?? [];
  const last = list[list.length - 1];
  if (last && lot < last.lot) list.length = 0; // datos corregidos: se empieza de nuevo
  if (!last || lot > last.lot || list.length === 0) list.push({ t: now, lot });
  while (list.length > 0 && now - list[0].t > 3 * 60 * 60 * 1000) list.shift();
  paceObservations.set(key, list);
}

function ringPaceFor(key: string, day: string, now: number): RingPace | null {
  const list = paceObservations.get(key);
  if (!list || list.length < 2) return null;
  const newest = list[list.length - 1];
  const window = list.filter((o) => now - o.t <= 90 * 60 * 1000);
  const oldest = window.length >= 2 ? window[0] : list[0];
  const lots = newest.lot - oldest.lot;
  const minutes = (newest.t - oldest.t) / 60000;
  if (lots < 4 || minutes < 8) return null;
  const minutesPerLot = Math.min(8, Math.max(0.5, minutes / lots));
  return { day, minutesPerLot: Math.round(minutesPerLot * 100) / 100, lastLot: newest.lot, observedAt: new Date(newest.t).toISOString() };
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

export async function getSaleResults(sale: Sale, userId?: string): Promise<SaleResultsResponse> {
  const hips = await db.hip.findMany({
    where: { saleId: sale.id },
    select: {
      id: true,
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
      barn: true,
    },
  });

  const decisions = userId
    ? await db.userDecision.findMany({ where: { userId, hip: { saleId: sale.id }, deletedAt: null }, select: { hipId: true, finalCall: true } })
    : [];
  const favoriteIds = new Set(decisions.map((d) => d.hipId));
  const decisionByHip = new Map(decisions.map((d) => [d.hipId, d.finalCall]));
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
      rnaAmount: result ? rnaReserveAmountOf({ priceRaw: str(result.priceRaw), purchaser: str(result.purchaser), soldAsCode: str(result.soldAsCode) }) : null,
      isFavorite: favoriteIds.has(hip.id),
      barn: hip.barn?.trim() || null,
      decision: decisionByHip.get(hip.id) ?? null,
    };
  });

  rows.sort((a, b) => {
    const [na, sa] = hipSortKey(a.hipNumber);
    const [nb, sb] = hipSortKey(b.hipNumber);
    return na !== nb ? na - nb : sa.localeCompare(sb);
  });

  // Ritmo del ring de HOY: lote (sin retirados) del último HIP que ya salió.
  const now = Date.now();
  const today = etDay.format(new Date(now));
  let lot = 0;
  let lastLot = 0;
  for (const row of rows) {
    if (row.day !== today) continue;
    const status = saleStatusOf({ priceRaw: row.priceRaw, purchaser: row.purchaser, soldAsCode: row.soldAsCode });
    if (status === "OUT") continue;
    lot += 1;
    if (status === "SOLD" || status === "RNA") lastLot = lot;
  }
  const paceKey = `${sale.id}|${today}`;
  if (lastLot > 0) recordRingLot(paceKey, lastLot, now);

  return {
    saleName: sale.name,
    status: getSaleLifecycleStatus(sale as unknown as { startDate: Date | null; endDate: Date | null }),
    generatedAt: new Date().toISOString(),
    rows,
    ringPace: lastLot > 0 ? ringPaceFor(paceKey, today, now) : null,
  };
}
