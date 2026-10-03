import type { SaleHouse } from "@prisma/client";
import { db } from "./db";
import { fetchWithRetry } from "./util/httpRetry";
import { normalizeHistoryResult } from "./saleHistoryService";

/**
 * MADRES VELOCISTAS ⚡ (2026-10-02, pedido de Ramon: "conseguir madres que
 * hayan sido velocistas o que hayan tenido hijos rápidos, que tengan hijos
 * en la próxima venta... amplía la búsqueda, los últimos 5 años... busca
 * los que trabajaron 10 o menos, 20.3 o menos y 32 o menos y coloca los
 * tiempos de cada hermano, la venta que lo hizo").
 *
 * Fuente: SOLO tiempos oficiales del Under Tack / Breeze Show de las ventas
 * de 2 años publicados por cada casa en su propia API (nada inventado ni
 * deducido):
 *   - OBS: campo `ut_time` / `ut_distance` de su API pública. OBS solo
 *     publica tiempos en la API desde 2024 (March/Spring/June 2024-2026);
 *     las ventas de 2022-2023 existen pero sin tiempos.
 *   - Fasig-Tipton: `under_tack_show_time` de su API (Midlantic mayo y
 *     junio, Gulfstream 2022 — la última que hubo).
 *
 * Cada trabajo se guarda UNA sola vez en BreezeRecord (solo lo necesario
 * para identificar al caballo, su tiempo y su resultado de venta: nada de
 * fotos, análisis ni PDFs). Las ventas de 2 años ya terminadas nunca se
 * vuelven a bajar (cero trabajo repetido).
 *
 * Cruce con un catálogo (por ej. Fasig-Tipton Kentucky October, OBS
 * October): por la MADRE de cada HIP.
 *   - HERMANO: el caballo que trabajó tiene la misma madre (y el mismo
 *     padre de la madre cuando las dos casas lo publican).
 *   - MADRE: la madre misma trabajó de potranca (su nombre coincide con el
 *     del caballo que trabajó Y su padre coincide con el padre de la madre
 *     del HIP — las dos condiciones, nunca solo el nombre).
 *
 * Un tiempo es ⚡ (élite) con los cortes que pidió Ramon:
 *   1/8 en 10.0 o menos · 1/4 en 20.3 o menos · 3/8 en 32.0 o menos.
 * Los tiempos de breeze se publican en QUINTOS de segundo: "9.4" = 9 y
 * 4/5 s, "20.3" = 20 y 3/5 s.
 */

// ---------------------------------------------------------------------------
// Fuentes (últimos 5 años) + descubrimiento automático de ventas nuevas
// ---------------------------------------------------------------------------

interface BreezeSource {
  house: SaleHouse;
  externalSaleId: string;
}

const KNOWN_SOURCES: BreezeSource[] = [
  // OBS: March / Spring / June 2024-2026 (las únicas con tiempos en la API).
  ...["135", "136", "137", "142", "144", "145", "149", "150", "151"].map((id) => ({ house: "OBS" as SaleHouse, externalSaleId: id })),
  // Fasig-Tipton: Gulfstream 2022, Midlantic mayo 2022-2026, Midlantic junio 2023-2024.
  ...["197", "198", "216", "219", "249", "254", "274", "297"].map((id) => ({ house: "FASIG_TIPTON" as SaleHouse, externalSaleId: id })),
];

const YEARS_BACK = 5;
const HEADERS = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (RM Selection)" };

// Cortes élite pedidos por Ramon (en segundos reales).
const ELITE_LIMITS: Record<string, number> = { "1/8": 10.0, "1/4": 20.6, "3/8": 32.0 };

/** "9.4" -> 9.8 s (quintos). Si el decimal no es un quinto válido (0-4), se toma como decimal común. */
export function breezeSeconds(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/^:/, "");
  const match = text.match(/^(\d{1,2})(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = match[2] ?? "0";
  if (frac.length === 1 && Number(frac) <= 4) return whole + Number(frac) / 5;
  return Number(`${whole}.${frac}`);
}

/** Tiempo para mostrar, siempre en la notación de la casa ("9.4", "20.3"). */
function breezeDisplay(raw: string | number): string {
  const text = String(raw).trim().replace(/^:/, "");
  return /^\d+$/.test(text) ? `${text}.0` : text;
}

function normalizeDistance(raw: string | null | undefined, seconds: number): string | null {
  const text = (raw ?? "").replace(/\s+/g, "");
  if (["1/8", "1/4", "3/8"].includes(text)) return text;
  // Fasig-Tipton no publica la distancia por caballo: se deduce sin
  // ambigüedad del propio tiempo (un 1/8 nunca pasa de 14 s, un 1/4 anda
  // en 19-26 s, un 3/8 en 30-40 s).
  if (seconds > 8 && seconds < 14) return "1/8";
  if (seconds >= 18 && seconds < 27) return "1/4";
  if (seconds >= 29 && seconds < 41) return "3/8";
  return null;
}

/** Clave de comparación de un nombre de caballo: sin país "(IRE)", sin signos, minúsculas. */
export function horseKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name
    .toLowerCase()
    .replace(/\([a-z]{2,4}\)/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
  return key.length ? key : null;
}

function yearOf(dateText: string | null | undefined): number | null {
  const m = dateText?.match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

interface BreezeRow {
  hipNumber: string;
  horseName: string | null;
  sex: string | null;
  sire: string | null;
  dam: string | null;
  damSire: string | null;
  foalYear: number | null;
  consignor: string | null;
  distance: string;
  timeRaw: string;
  seconds: number;
  workDate: Date | null;
  priceRaw: string | null;
  purchaser: string | null;
  resultCode: string | null;
  videoUrl: string | null;
}

interface SaleMeta {
  saleName: string;
  saleDate: Date;
  rows: BreezeRow[];
}

function parseUsDate(text: string | null | undefined): Date | null {
  const m = text?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 12)) : null;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const response = await fetchWithRetry(url, { headers: HEADERS });
  if (response.status === 404) return null;
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}: ${body.slice(0, 200)}`);
  if (!body.trim()) return null;
  return JSON.parse(body);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchObsBreezes(saleId: string): Promise<SaleMeta | null> {
  const sale = (await fetchJson(`https://obssales.com/wp-json/obs-catalog-wp-plugin/v1/horse-sales/${saleId}?is_digital=false`)) as any;
  if (!sale || String(sale.sale_category).toLowerCase() !== "2yo") return null;
  const rows: BreezeRow[] = [];
  for (const h of (sale.sale_hip ?? []) as any[]) {
    const seconds = breezeSeconds(h.ut_time);
    if (seconds === null) continue;
    const distance = normalizeDistance(h.ut_distance, seconds);
    if (!distance) continue;
    const rna = String(h.rna_summary_indicator ?? "").toUpperCase() === "Y";
    const out = String(h.in_out_status ?? "").toUpperCase() === "O";
    const hammer = Number(h.hammer_price ?? 0);
    const rnaPrice = Number(h.sale_price_rna ?? 0);
    rows.push({
      hipNumber: String(h.hip_number),
      horseName: h.horse_name?.trim() || null,
      sex: h.sex ?? null,
      sire: h.sire_name?.trim() || null,
      dam: h.dam_name?.trim() || null,
      damSire: h.dam_sire?.trim() || null,
      foalYear: Number(h.foaling_year) || yearOf(h.foaling_date),
      consignor: h.consignor_name?.trim() || null,
      distance,
      timeRaw: breezeDisplay(h.ut_time),
      seconds,
      workDate: parseUsDate(h.ut_actual_date) ?? parseUsDate(h.ut_expected_date),
      priceRaw: rna ? (rnaPrice > 0 ? `R.N.A. (${rnaPrice})` : "R.N.A.") : hammer > 0 ? String(hammer) : null,
      purchaser: out ? "OUT" : rna ? null : h.buyer_name?.trim() || null,
      resultCode: out ? "OUT" : rna ? "RNA" : null,
      videoUrl: h.video_link?.trim() || null,
    });
  }
  return {
    saleName: `OBS ${String(sale.sale_name ?? "").trim()}`,
    saleDate: new Date(String(sale.sale_starts ?? "").replace(" ", "T") + "Z"),
    rows,
  };
}

async function fetchFtBreezes(saleId: string): Promise<SaleMeta | null> {
  const meta = (await fetchJson(`https://www.fasigtipton.com/django/api/sales/${saleId}/`)) as any;
  if (!meta || !meta.under_tack_show_start_day) return null;
  const horses = ((await fetchJson(`https://www.fasigtipton.com/django/api/horses/?sale=${saleId}`)) as any[]) ?? [];
  const rows: BreezeRow[] = [];
  for (const h of horses) {
    const seconds = breezeSeconds(h.under_tack_show_time);
    if (seconds === null || seconds <= 0) continue;
    const distance = normalizeDistance(null, seconds);
    if (!distance) continue;
    const purchaser = h.purchaser?.trim() || null;
    rows.push({
      hipNumber: String(h.hip),
      horseName: h.name?.trim() || null,
      sex: h.sex ?? null,
      sire: h.sire?.trim() || null,
      dam: h.dam?.trim() || null,
      damSire: h.sire_of_dam?.trim() || null,
      foalYear: yearOf(h.year_of_birth),
      consignor: h.consignor_name?.trim() || h.consignor?.trim() || null,
      distance,
      timeRaw: breezeDisplay(h.under_tack_show_time),
      seconds,
      workDate: h.under_tack_show_day ? new Date(`${h.under_tack_show_day}T12:00:00Z`) : null,
      priceRaw: h.price ? String(h.price) : null,
      purchaser,
      resultCode: h.sold_as_code?.trim() || null,
      videoUrl: h.under_tack_show_video?.trim() || null,
    });
  }
  const id = String(meta.sale_identifier ?? "");
  const year = String(meta.sale_start_day ?? "").slice(0, 4);
  const month = String(meta.sale_start_day ?? "").slice(5, 7);
  const name = id.startsWith("F")
    ? `Fasig-Tipton Gulfstream 2YO ${year}`
    : `Fasig-Tipton Midlantic 2YO ${month === "06" ? "Junio" : "Mayo"} ${year}`;
  return { saleName: name, saleDate: new Date(`${meta.sale_start_day}T12:00:00Z`), rows };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function importSource(source: BreezeSource): Promise<number> {
  const already = await db.breezeRecord.count({ where: { house: source.house, externalSaleId: source.externalSaleId } });
  if (already > 0) return 0;
  const sale = source.house === "OBS" ? await fetchObsBreezes(source.externalSaleId) : await fetchFtBreezes(source.externalSaleId);
  if (!sale || sale.rows.length === 0) return 0;
  if (sale.saleDate.getTime() > Date.now()) return 0; // venta todavía no hecha

  // Puesto de cada tiempo dentro de SU venta y distancia ("3º de 412").
  const byDistance = new Map<string, number[]>();
  for (const row of sale.rows) {
    const list = byDistance.get(row.distance) ?? [];
    list.push(row.seconds);
    byDistance.set(row.distance, list);
  }
  const saleYear = sale.saleDate.getUTCFullYear();
  const data = sale.rows.map((row) => {
    const field = byDistance.get(row.distance)!;
    const rank = 1 + field.filter((s) => s < row.seconds - 1e-9).length;
    return {
      house: source.house,
      externalSaleId: source.externalSaleId,
      saleName: sale.saleName,
      saleYear,
      hipNumber: row.hipNumber,
      horseName: row.horseName,
      nameKey: horseKey(row.horseName),
      sex: row.sex,
      sire: row.sire,
      sireKey: horseKey(row.sire),
      dam: row.dam,
      damKey: horseKey(row.dam),
      damSire: row.damSire,
      damSireKey: horseKey(row.damSire),
      foalYear: row.foalYear,
      consignor: row.consignor,
      distance: row.distance,
      timeRaw: row.timeRaw,
      seconds: row.seconds,
      isElite: row.seconds <= ELITE_LIMITS[row.distance] + 1e-9,
      rankInSale: rank,
      fieldSize: field.length,
      workDate: row.workDate,
      priceRaw: row.priceRaw,
      purchaser: row.purchaser,
      resultCode: row.resultCode,
      videoUrl: row.videoUrl,
    };
  });
  await db.breezeRecord.createMany({ data, skipDuplicates: true });
  return data.length;
}

/**
 * Descubre ventas de 2 años NUEVAS (las del año que viene en adelante) sin
 * tocar ninguna ya importada: prueba pocos ids por encima del último
 * conocido de cada casa. Liviano: solo metadatos de la venta.
 */
async function discoverNewSources(): Promise<BreezeSource[]> {
  const found: BreezeSource[] = [];
  const known = new Set(KNOWN_SOURCES.map((s) => `${s.house}|${s.externalSaleId}`));
  const imported = await db.breezeRecord.groupBy({ by: ["house", "externalSaleId"] });
  for (const row of imported) known.add(`${row.house}|${row.externalSaleId}`);

  const maxOf = (house: SaleHouse) =>
    Math.max(...[...known].filter((k) => k.startsWith(`${house}|`)).map((k) => Number(k.split("|")[1]) || 0));
  const cutoffYear = new Date().getUTCFullYear() - YEARS_BACK + 1;

  for (let id = maxOf("OBS") + 1; id <= maxOf("OBS") + 12; id++) {
    try {
      const sale = (await fetchJson(`https://obssales.com/wp-json/obs-catalog-wp-plugin/v1/horse-sales/${id}?is_digital=false`)) as { sale_category?: string; sale_starts?: string } | null;
      if (sale && String(sale.sale_category).toLowerCase() === "2yo" && Number(String(sale.sale_starts).slice(0, 4)) >= cutoffYear) {
        found.push({ house: "OBS", externalSaleId: String(id) });
      }
    } catch {
      /* id inexistente o casa caída: se reintenta en el próximo arranque */
    }
  }
  for (let id = maxOf("FASIG_TIPTON") + 1; id <= maxOf("FASIG_TIPTON") + 30; id++) {
    try {
      const sale = (await fetchJson(`https://www.fasigtipton.com/django/api/sales/${id}/`)) as { under_tack_show_start_day?: string } | null;
      if (sale?.under_tack_show_start_day) found.push({ house: "FASIG_TIPTON", externalSaleId: String(id) });
    } catch {
      /* idem */
    }
  }
  return found;
}

let importing = false;

/** Importa (una sola vez) los tiempos de breeze de los últimos 5 años + ventas nuevas. Idempotente. */
export async function importBreezeRecords(): Promise<void> {
  if (importing) return;
  importing = true;
  try {
    const sources = [...KNOWN_SOURCES, ...(await discoverNewSources().catch(() => []))];
    let total = 0;
    for (const source of sources) {
      try {
        const count = await importSource(source);
        if (count > 0) {
          total += count;
          console.log(`[speed-dam] ${source.house}/${source.externalSaleId}: ${count} trabajos guardados.`);
        }
      } catch (err) {
        console.error(`[speed-dam] Error importando ${source.house}/${source.externalSaleId}:`, err);
      }
    }
    if (total > 0) indexCache.clear();
    const elite = await db.breezeRecord.count({ where: { isElite: true } });
    const all = await db.breezeRecord.count();
    console.log(`[speed-dam] Base de breezes: ${all} trabajos, ${elite} élite (1/8 ≤ 10.0 · 1/4 ≤ 20.3 · 3/8 ≤ 32.0).`);
  } finally {
    importing = false;
  }
}

// ---------------------------------------------------------------------------
// Cruce con un catálogo
// ---------------------------------------------------------------------------

type BreezeRecordRow = Awaited<ReturnType<typeof db.breezeRecord.findMany>>[number];

interface TargetHip {
  hipNumber: string;
  dam: string | null;
  damSire: string | null;
  foalYear: number | null;
  foalingDate: Date | null;
}

function sameOrUnknown(a: string | null, b: string | null): boolean {
  return !a || !b || a === b;
}

function matchesFor(hip: TargetHip, byDam: Map<string, BreezeRecordRow[]>, byName: Map<string, BreezeRecordRow[]>) {
  const damKey = horseKey(hip.dam);
  const damSireKey = horseKey(hip.damSire);
  if (!damKey) return { siblings: [] as BreezeRecordRow[], dam: [] as BreezeRecordRow[] };
  const foalYear = hip.foalYear ?? hip.foalingDate?.getUTCFullYear() ?? null;
  const siblings = (byDam.get(damKey) ?? []).filter(
    (r) => sameOrUnknown(r.damSireKey, damSireKey) && (foalYear === null || r.foalYear === null || r.foalYear < foalYear)
  );
  // La madre misma: nombre igual Y su padre igual al padre de la madre del
  // HIP (las dos cosas, nunca solo el nombre).
  const dam = damSireKey ? (byName.get(damKey) ?? []).filter((r) => r.sireKey === damSireKey) : [];
  return { siblings, dam };
}

async function loadMatchesForSale(saleId: string) {
  const hips = await db.hip.findMany({
    where: { saleId, dam: { not: null } },
    select: { hipNumber: true, dam: true, damSire: true, foalYear: true, foalingDate: true },
  });
  const damKeys = [...new Set(hips.map((h) => horseKey(h.dam)).filter((k): k is string => !!k))];
  if (damKeys.length === 0) return { hips, byDam: new Map(), byName: new Map() };
  const records = await db.breezeRecord.findMany({
    where: { OR: [{ damKey: { in: damKeys } }, { nameKey: { in: damKeys } }] },
  });
  const byDam = new Map<string, BreezeRecordRow[]>();
  const byName = new Map<string, BreezeRecordRow[]>();
  for (const r of records) {
    if (r.damKey) byDam.set(r.damKey, [...(byDam.get(r.damKey) ?? []), r]);
    if (r.nameKey) byName.set(r.nameKey, [...(byName.get(r.nameKey) ?? []), r]);
  }
  return { hips, byDam, byName };
}

export interface SpeedDamIndexEntry {
  /** Trabajos élite: hermanos élite + la madre si fue élite. */
  elite: number;
  /** Mejor tiempo élite, en notación de la casa con su distancia ("9.4 1/8"). */
  best: string;
  /** La madre misma trabajó en tiempo élite. */
  damElite: boolean;
}

const indexCache = new Map<string, { at: number; value: Record<string, SpeedDamIndexEntry> }>();
const INDEX_TTL_MS = 20 * 60 * 1000;

/** HIP -> resumen ⚡, solo HIPs con al menos un trabajo élite en la familia. Una sola consulta por venta. */
export async function speedDamIndex(saleId: string): Promise<Record<string, SpeedDamIndexEntry>> {
  const cached = indexCache.get(saleId);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.value;
  const { hips, byDam, byName } = await loadMatchesForSale(saleId);
  const result: Record<string, SpeedDamIndexEntry> = {};
  for (const hip of hips) {
    const { siblings, dam } = matchesFor(hip, byDam, byName);
    const eliteRows = [...siblings, ...dam].filter((r) => r.isElite);
    if (eliteRows.length === 0) continue;
    // "Mejor" = el que más margen le saca a su corte élite.
    const best = eliteRows.reduce((a, b) => (b.seconds - ELITE_LIMITS[b.distance] < a.seconds - ELITE_LIMITS[a.distance] ? b : a));
    result[hip.hipNumber] = { elite: eliteRows.length, best: `${best.timeRaw} ${best.distance}`, damElite: dam.some((r) => r.isElite) };
  }
  indexCache.set(saleId, { at: Date.now(), value: result });
  return result;
}

export interface SpeedDamWork {
  relation: "SIBLING" | "DAM";
  horseName: string | null;
  sex: string | null;
  sire: string | null;
  foalYear: number | null;
  house: SaleHouse;
  saleName: string;
  saleYear: number;
  hipNumber: string;
  distance: string;
  time: string;
  seconds: number;
  isElite: boolean;
  isBullet: boolean;
  rankInSale: number;
  fieldSize: number;
  topPercent: number;
  workDate: string | null;
  consignor: string | null;
  status: "SOLD" | "PS" | "RNA" | "OUT" | "NONE";
  amount: number | null;
  buyer: string | null;
  videoUrl: string | null;
}

export interface SpeedDamDetail {
  hipNumber: string;
  dam: string | null;
  damSire: string | null;
  eliteCount: number;
  siblingsBreezed: number;
  damBreezed: boolean;
  limits: string;
  coverage: string;
  works: SpeedDamWork[];
}

function toWork(r: BreezeRecordRow, relation: "SIBLING" | "DAM"): SpeedDamWork {
  const result = normalizeHistoryResult(r.priceRaw, r.purchaser, r.resultCode);
  return {
    relation,
    horseName: r.horseName,
    sex: r.sex,
    sire: r.sire,
    foalYear: r.foalYear,
    house: r.house,
    saleName: r.saleName,
    saleYear: r.saleYear,
    hipNumber: r.hipNumber,
    distance: r.distance,
    time: r.timeRaw,
    seconds: r.seconds,
    isElite: r.isElite,
    isBullet: r.rankInSale === 1,
    rankInSale: r.rankInSale,
    fieldSize: r.fieldSize,
    topPercent: Math.max(1, Math.ceil((r.rankInSale / Math.max(1, r.fieldSize)) * 100)),
    workDate: r.workDate ? r.workDate.toISOString().slice(0, 10) : null,
    consignor: r.consignor,
    status: result.status,
    amount: result.amount,
    buyer: result.buyer,
    videoUrl: r.videoUrl,
  };
}

export const SPEED_DAM_LIMITS_TEXT = "1/8 ≤ 10.0 · 1/4 ≤ 20.3 · 3/8 ≤ 32.0";
export const SPEED_DAM_COVERAGE_TEXT = "OBS 2YO 2024-2026 · Fasig-Tipton 2YO 2022-2025";

/** Detalle de un HIP: TODOS los trabajos de sus hermanos (élite primero) + los de la madre. */
export async function speedDamDetail(saleId: string, hipNumber: string): Promise<SpeedDamDetail | null> {
  const hip = await db.hip.findUnique({
    where: { saleId_hipNumber: { saleId, hipNumber } },
    select: { hipNumber: true, dam: true, damSire: true, foalYear: true, foalingDate: true },
  });
  if (!hip) return null;
  const damKey = horseKey(hip.dam);
  const records = damKey ? await db.breezeRecord.findMany({ where: { OR: [{ damKey }, { nameKey: damKey }] } }) : [];
  const byDam = new Map<string, BreezeRecordRow[]>();
  const byName = new Map<string, BreezeRecordRow[]>();
  for (const r of records) {
    if (r.damKey) byDam.set(r.damKey, [...(byDam.get(r.damKey) ?? []), r]);
    if (r.nameKey) byName.set(r.nameKey, [...(byName.get(r.nameKey) ?? []), r]);
  }
  const { siblings, dam } = matchesFor(hip, byDam, byName);
  const works = [...dam.map((r) => toWork(r, "DAM")), ...siblings.map((r) => toWork(r, "SIBLING"))].sort(
    (a, b) =>
      Number(b.relation === "DAM") - Number(a.relation === "DAM") ||
      Number(b.isElite) - Number(a.isElite) ||
      a.seconds - ELITE_LIMITS[a.distance] - (b.seconds - ELITE_LIMITS[b.distance])
  );
  return {
    hipNumber: hip.hipNumber,
    dam: hip.dam,
    damSire: hip.damSire,
    eliteCount: works.filter((w) => w.isElite).length,
    siblingsBreezed: new Set(siblings.map((s) => `${s.sireKey}|${s.foalYear}`)).size,
    damBreezed: dam.length > 0,
    limits: SPEED_DAM_LIMITS_TEXT,
    coverage: SPEED_DAM_COVERAGE_TEXT,
    works,
  };
}
