import { db } from "./db";
import { normalizeHistoryResult } from "./saleHistoryService";

/**
 * Reinscritos (2026-10-04, pedido de Ramon): cuando un caballo terminó RNA,
 * scratch (OUT) o simplemente pasó por una venta, ¿ya está inscrito en una
 * venta POSTERIOR? Se cruza SOLO contra catálogo que RM Selection ya
 * importó (los catálogos de próximas ventas entran solos con el daily-sync);
 * no se descarga nada de ventas terminadas.
 *
 * Mismo principio de evidencia que el Historial de Ventas
 * (saleHistoryService.ts): nunca por un solo dato.
 *   - padre + madre iguales (sin distinguir mayúsculas)
 *   - año de nacimiento conocido de los dos lados e igual (un hermano
 *     propio de otro año tiene los mismos dos nombres)
 *   - sexo: si se conoce de los dos lados tiene que coincidir (G/R = C)
 *   CONFIRMED: además la fecha de nacimiento exacta coincide.
 *   LIKELY: todo lo anterior, pero falta la fecha completa en algún lado.
 */

export interface ReentryMatch {
  house: string;
  externalSaleId: string;
  saleName: string;
  saleDate: string | null;
  hipNumber: string;
  consignor: string | null;
  confidence: "CONFIRMED" | "LIKELY";
  status: string | null;
}

interface HipLite {
  hipNumber: string;
  sire: string | null;
  dam: string | null;
  sex: string | null;
  foalYear: number | null;
  foalingDate: Date | null;
}

function norm(v: string | null | undefined): string | null {
  const t = v?.trim().toLowerCase().replace(/\s*\([a-z]{2,3}\)\s*$/, "").replace(/\s+/g, " ");
  return t ? t : null;
}

function yearOf(h: HipLite): number | null {
  if (h.foalYear != null) return h.foalYear;
  return h.foalingDate ? h.foalingDate.getUTCFullYear() : null;
}

function sexKey(raw: string | null | undefined): string | null {
  const first = raw?.trim().toUpperCase().charAt(0);
  if (!first) return null;
  return first === "G" || first === "R" ? "C" : first;
}

function sameDay(a: Date | null, b: Date | null): boolean | null {
  if (!a || !b) return null;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function statusOf(json: unknown): string | null {
  const r = json as { priceRaw?: string | null; purchaser?: string | null; soldAsCode?: string | null } | null;
  if (!r) return null;
  const status = normalizeHistoryResult(r.priceRaw ?? null, r.purchaser ?? null, r.soldAsCode ?? null).status;
  return status === "NONE" ? null : status;
}

const CACHE_MS = 20 * 60 * 1000;
const cache = new Map<string, { at: number; hips: Record<string, ReentryMatch[]> }>();

/** Se llama al importar un catálogo nuevo: los cruces cambian. */
export function clearReentryCache(): void {
  cache.clear();
}

/** HIP Number -> ventas POSTERIORES donde ese mismo caballo está inscrito. */
export async function reentryIndex(saleId: string): Promise<Record<string, ReentryMatch[]>> {
  const cached = cache.get(saleId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.hips;

  const sale = await db.sale.findUnique({ where: { id: saleId }, select: { startDate: true, endDate: true } });
  const from = sale?.startDate ?? null;
  if (!from) {
    cache.set(saleId, { at: Date.now(), hips: {} });
    return {};
  }

  const select = { hipNumber: true, sire: true, dam: true, sex: true, foalYear: true, foalingDate: true } as const;
  const own: HipLite[] = await db.hip.findMany({ where: { saleId }, select });

  const later = await db.hip.findMany({
    where: { saleId: { not: saleId }, sale: { startDate: { gt: from } } },
    select: {
      ...select,
      consignor: true,
      saleResultJson: true,
      sale: { select: { house: true, externalSaleId: true, name: true, startDate: true } },
    },
  });

  const byKey = new Map<string, typeof later>();
  for (const c of later) {
    const s = norm(c.sire), d = norm(c.dam), y = yearOf(c);
    if (!s || !d || y == null) continue;
    const key = `${s}|${d}|${y}`;
    const list = byKey.get(key);
    if (list) list.push(c); else byKey.set(key, [c]);
  }

  const result: Record<string, ReentryMatch[]> = {};
  for (const h of own) {
    const s = norm(h.sire), d = norm(h.dam), y = yearOf(h);
    if (!s || !d || y == null) continue;
    const candidates = byKey.get(`${s}|${d}|${y}`);
    if (!candidates) continue;
    const matches: ReentryMatch[] = [];
    for (const c of candidates) {
      const a = sexKey(h.sex), b = sexKey(c.sex);
      if (a && b && a !== b) continue;
      const day = sameDay(h.foalingDate, c.foalingDate);
      if (day === false) continue;
      matches.push({
        house: c.sale.house,
        externalSaleId: c.sale.externalSaleId,
        saleName: c.sale.name,
        saleDate: c.sale.startDate ? c.sale.startDate.toISOString() : null,
        hipNumber: c.hipNumber,
        consignor: c.consignor ?? null,
        confidence: day === true && a != null && b != null ? "CONFIRMED" : "LIKELY",
        status: statusOf(c.saleResultJson),
      });
    }
    if (matches.length) {
      matches.sort((x, y2) => (x.saleDate ?? "").localeCompare(y2.saleDate ?? ""));
      result[h.hipNumber] = matches;
    }
  }

  cache.set(saleId, { at: Date.now(), hips: result });
  return result;
}

/**
 * Aviso de reinscritos: para una lista de HIPs (favoritos/analizados del
 * usuario) devuelve los que aparecen en una venta posterior.
 */
export async function reentryCheck(
  items: Array<{ house: string; externalSaleId: string; hipNumber: string }>,
): Promise<Array<{ house: string; externalSaleId: string; hipNumber: string; saleName: string; matches: ReentryMatch[] }>> {
  const bySale = new Map<string, { house: string; externalSaleId: string; hips: Set<string> }>();
  for (const it of items.slice(0, 500)) {
    if (!it?.house || !it?.externalSaleId || !it?.hipNumber) continue;
    const key = `${it.house}::${it.externalSaleId}`;
    const entry = bySale.get(key) ?? { house: it.house, externalSaleId: it.externalSaleId, hips: new Set<string>() };
    entry.hips.add(String(it.hipNumber));
    bySale.set(key, entry);
  }
  const out: Array<{ house: string; externalSaleId: string; hipNumber: string; saleName: string; matches: ReentryMatch[] }> = [];
  for (const entry of bySale.values()) {
    const sale = await db.sale.findUnique({
      where: { house_externalSaleId: { house: entry.house as never, externalSaleId: entry.externalSaleId } },
      select: { id: true, name: true },
    });
    if (!sale) continue;
    const index = await reentryIndex(sale.id);
    for (const hip of entry.hips) {
      const matches = index[hip];
      if (matches?.length) out.push({ house: entry.house, externalSaleId: entry.externalSaleId, hipNumber: hip, saleName: sale.name, matches });
    }
  }
  return out;
}
