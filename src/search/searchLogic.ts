// Advanced Search — reglas puras (2026-09-27, pedido explícito de Ramon:
// "TAREA NUEVA — CREAR ADVANCED SEARCH EN RM SELECTION").
//
// Módulo SIN base de datos: valida el pedido, calcula los campos derivados
// (score IA, resultado de venta, precio, año de nacimiento, color
// normalizado), aplica los filtros sobre esos campos, ordena y pagina.
// searchService.ts solo lee de la base y le pasa los datos a estas
// funciones. Search es SOLO LECTURA: nada acá escribe ni dispara procesos.
import { HttpError } from "../api/errorHandler";
import { rankingScoreFromAnalysis, compareHipNumbers, RankingAnalysisInput } from "../rankingSelection";
import { CLASSIFICATION_THRESHOLDS } from "../analysis/conformationScores";

export const SEARCH_DEFAULT_PAGE_SIZE = 50;
export const SEARCH_MAX_PAGE_SIZE = 100;
const MAX_TEXT_LENGTH = 100;
const MAX_LIST_LENGTH = 200;

export const SALE_HOUSES = ["KEENELAND", "FASIG_TIPTON", "OBS"] as const;
export type SaleHouseCode = (typeof SALE_HOUSES)[number];
export const SALE_STATUSES = ["SOLD", "RNA", "OUT", "NO_RESULT"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export const AI_CLASSES = ["EXCELENTE", "BIEN", "REVISAR", "NOT_ANALYZED"] as const;
export type AiClass = (typeof AI_CLASSES)[number];
export const SORT_FIELDS = ["HIP", "AI_SCORE", "PRICE", "SALE_DATE"] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortDirection = "ASC" | "DESC";
export type ReviewedMode = "REVIEWED" | "NOT_REVIEWED";

/** Colores canónicos — los catálogos los escriben de formas distintas ("B", "Bay", "DB/BR", "Dark Bay or Brown"...). */
export const CANONICAL_COLORS = ["Bay", "Dark Bay/Brown", "Chestnut", "Gray/Roan", "Black"] as const;

/**
 * Campos que el boceto pide pero que HOY no existen en la base de RM
 * Selection (ni en ningún catálogo sincronizado). Se informan a la app
 * para mostrarlos como "Not available" — nunca se inventan.
 */
export const UNAVAILABLE_FIELDS = ["grandsire", "stakeProducingDam", "stateFoaled", "damBirthYear", "breedersCupEligible"] as const;

export interface SearchRequest {
  q?: string;
  saleIds?: string[];
  houses?: SaleHouseCode[];
  years?: number[];
  books?: string[];
  sessions?: number[];
  saleDateFrom?: string; // YYYY-MM-DD (día calendario de la venta, ET)
  saleDateTo?: string;
  sire?: string;
  dam?: string;
  damSire?: string;
  horseName?: string;
  consignor?: string;
  barn?: string;
  sexes?: string[];
  colors?: string[];
  birthYearFrom?: number;
  birthYearTo?: number;
  hipFrom?: number;
  hipTo?: number;
  saleStatuses?: SaleStatus[];
  priceMin?: number;
  priceMax?: number;
  aiScoreMin?: number;
  aiScoreMax?: number;
  aiClasses?: AiClass[];
  favoritesOnly?: boolean;
  reviewed?: ReviewedMode;
  reviewedKeys?: string[];
  sort: { field: SortField; direction: SortDirection };
  page: number;
  pageSize: number;
}

// ─── Validación del pedido ───────────────────────────────────────────────

function bad(message: string): never {
  throw new HttpError(400, message, "INVALID_SEARCH");
}

function optText(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") bad(`'${name}' debe ser texto.`);
  const t = v.trim();
  if (t.length > MAX_TEXT_LENGTH) bad(`'${name}' es demasiado largo.`);
  return t.length ? t : undefined;
}

function optNumber(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) bad(`'${name}' debe ser un número entre ${min} y ${max}.`);
  return n;
}

function optList<T>(v: unknown, name: string, item: (x: unknown) => T): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) bad(`'${name}' debe ser una lista.`);
  if (v.length > MAX_LIST_LENGTH) bad(`'${name}' tiene demasiados elementos.`);
  const out = v.map(item);
  return out.length ? out : undefined;
}

function oneOf<T extends string>(values: readonly T[], name: string) {
  return (x: unknown): T => {
    if (typeof x !== "string" || !(values as readonly string[]).includes(x)) bad(`Valor inválido en '${name}': ${String(x)}.`);
    return x as T;
  };
}

function textItem(name: string) {
  return (x: unknown): string => {
    if (typeof x !== "string" || !x.trim() || x.length > MAX_TEXT_LENGTH) bad(`Valor inválido en '${name}'.`);
    return x.trim();
  };
}

function isoDay(v: unknown, name: string): string | undefined {
  const t = optText(v, name);
  if (t === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(new Date(`${t}T12:00:00Z`).getTime())) bad(`'${name}' debe tener formato AAAA-MM-DD.`);
  return t;
}

function ordered(a: number | undefined, b: number | undefined, name: string) {
  if (a !== undefined && b !== undefined && a > b) bad(`Rango inválido en '${name}': el mínimo es mayor que el máximo.`);
}

/** Valida y normaliza el cuerpo de POST /search. Cualquier dato inválido -> HttpError 400 (nunca se "adivina"). */
export function parseSearchRequest(body: unknown): SearchRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sortRaw = (b.sort && typeof b.sort === "object" ? b.sort : {}) as Record<string, unknown>;
  const req: SearchRequest = {
    q: optText(b.q, "q"),
    saleIds: optList(b.saleIds, "saleIds", textItem("saleIds")),
    houses: optList(b.houses, "houses", oneOf(SALE_HOUSES, "houses")),
    years: optList(b.years, "years", (x) => optNumber(x, "years", 1990, 2100)!),
    books: optList(b.books, "books", textItem("books")),
    sessions: optList(b.sessions, "sessions", (x) => optNumber(x, "sessions", 1, 99)!),
    saleDateFrom: isoDay(b.saleDateFrom, "saleDateFrom"),
    saleDateTo: isoDay(b.saleDateTo, "saleDateTo"),
    sire: optText(b.sire, "sire"),
    dam: optText(b.dam, "dam"),
    damSire: optText(b.damSire, "damSire"),
    horseName: optText(b.horseName, "horseName"),
    consignor: optText(b.consignor, "consignor"),
    barn: optText(b.barn, "barn"),
    sexes: optList(b.sexes, "sexes", textItem("sexes")),
    colors: optList(b.colors, "colors", oneOf(CANONICAL_COLORS, "colors")),
    birthYearFrom: optNumber(b.birthYearFrom, "birthYearFrom", 1990, 2100),
    birthYearTo: optNumber(b.birthYearTo, "birthYearTo", 1990, 2100),
    hipFrom: optNumber(b.hipFrom, "hipFrom", 0, 100000),
    hipTo: optNumber(b.hipTo, "hipTo", 0, 100000),
    saleStatuses: optList(b.saleStatuses, "saleStatuses", oneOf(SALE_STATUSES, "saleStatuses")),
    priceMin: optNumber(b.priceMin, "priceMin", 0, 1e9),
    priceMax: optNumber(b.priceMax, "priceMax", 0, 1e9),
    aiScoreMin: optNumber(b.aiScoreMin, "aiScoreMin", 0, 10),
    aiScoreMax: optNumber(b.aiScoreMax, "aiScoreMax", 0, 10),
    aiClasses: optList(b.aiClasses, "aiClasses", oneOf(AI_CLASSES, "aiClasses")),
    favoritesOnly: b.favoritesOnly === undefined ? undefined : b.favoritesOnly === true,
    reviewed: b.reviewed === undefined || b.reviewed === null ? undefined : oneOf(["REVIEWED", "NOT_REVIEWED"] as const, "reviewed")(b.reviewed),
    reviewedKeys: b.reviewedKeys === undefined ? undefined : (() => {
      if (!Array.isArray(b.reviewedKeys)) bad("'reviewedKeys' debe ser una lista.");
      if (b.reviewedKeys.length > 20000) bad("'reviewedKeys' tiene demasiados elementos.");
      return (b.reviewedKeys as unknown[]).filter((k): k is string => typeof k === "string");
    })(),
    sort: {
      field: sortRaw.field === undefined ? "HIP" : oneOf(SORT_FIELDS, "sort.field")(sortRaw.field),
      direction: sortRaw.direction === undefined ? "ASC" : oneOf(["ASC", "DESC"] as const, "sort.direction")(sortRaw.direction),
    },
    page: optNumber(b.page, "page", 1, 100000) ?? 1,
    pageSize: optNumber(b.pageSize, "pageSize", 1, SEARCH_MAX_PAGE_SIZE) ?? SEARCH_DEFAULT_PAGE_SIZE,
  };
  req.page = Math.floor(req.page);
  req.pageSize = Math.floor(req.pageSize);
  ordered(req.birthYearFrom, req.birthYearTo, "año de nacimiento");
  ordered(req.hipFrom, req.hipTo, "HIP");
  ordered(req.priceMin, req.priceMax, "precio");
  ordered(req.aiScoreMin, req.aiScoreMax, "AI Score");
  if (req.saleDateFrom && req.saleDateTo && req.saleDateFrom > req.saleDateTo) bad("Rango inválido en 'fecha de venta'.");
  if (req.reviewed && !req.reviewedKeys) bad("'reviewed' necesita 'reviewedKeys' (la lista de HIP revisados de este dispositivo).");
  return req;
}

// ─── Campos derivados ────────────────────────────────────────────────────

/** Clave estable del HIP — la MISMA que `Hip.id` en la app ("HOUSE::externalSaleId::hipNumber"). */
export function hipKey(house: string, externalSaleId: string, hipNumber: string): string {
  return `${house}::${externalSaleId}::${hipNumber}`;
}

export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase().replace(/\./g, "");
  if (!c) return null;
  if (c === "B" || c === "BAY") return "Bay";
  if (c === "CH" || c === "CHESTNUT") return "Chestnut";
  if (c === "BLK" || c === "BL" || c === "BLACK") return "Black";
  if (c.startsWith("GR") || c.includes("GRAY") || c.includes("GREY") || c.includes("ROAN")) return "Gray/Roan";
  if (c.startsWith("DB") || c.startsWith("DK") || c.includes("DARK BAY") || c.includes("BROWN") || c === "BR") return "Dark Bay/Brown";
  return null;
}

/** Año de nacimiento: la fecha completa si existe; si no, el año que publica el catálogo. */
export function birthYearOf(foalingDate: Date | null | undefined, foalYear: number | null | undefined): number | null {
  if (foalingDate && !Number.isNaN(foalingDate.getTime())) return foalingDate.getUTCFullYear();
  return typeof foalYear === "number" ? foalYear : null;
}

export interface SaleResultInput {
  priceRaw?: string | null;
  purchaser?: string | null;
  soldAsCode?: string | null;
}

/**
 * Resultado de venta — MISMA regla que `SaleResult.outcome` de la app
 * (Models/Hip.swift), para que Search nunca muestre algo distinto de lo que
 * ya se ve en la ficha: RNA -> RNA; PS (post-sale) -> vendido; OUT/
 * SCRATCHED/WD/WITHDRAWN sin precio -> OUT; con precio -> vendido; si no,
 * sin resultado.
 */
export function saleStatusOf(result: SaleResultInput | null | undefined): SaleStatus {
  if (!result) return "NO_RESULT";
  const code = (result.soldAsCode ?? "").trim().toUpperCase();
  const price = (result.priceRaw ?? "").trim();
  if (code === "RNA") return "RNA";
  if (code === "PS") return "SOLD";
  if (["OUT", "SCRATCHED", "WD", "WITHDRAWN"].includes(code) && !price) return "OUT";
  if (price) return "SOLD";
  return "NO_RESULT";
}

/** Precio de venta real (solo de un HIP vendido); nunca se deduce de un texto de RNA. */
export function salePriceOf(result: SaleResultInput | null | undefined): number | null {
  if (saleStatusOf(result) !== "SOLD") return null;
  const n = Number((result?.priceRaw ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Score IA válido (misma regla única del Ranking del Día) o null = "Not analyzed". */
export function aiScoreOf(analysis: RankingAnalysisInput | null | undefined): number | null {
  return rankingScoreFromAnalysis(analysis);
}

/** Excelente 8.5–10 · Bien 7.0–8.4 · Revisar ≤6.9 · sin score -> Not analyzed. */
export function aiClassOf(score: number | null): AiClass {
  if (score === null) return "NOT_ANALYZED";
  if (score >= CLASSIFICATION_THRESHOLDS.excelenteMinimo) return "EXCELENTE";
  if (score >= CLASSIFICATION_THRESHOLDS.bienMinimo) return "BIEN";
  return "REVISAR";
}

// ─── Filtros sobre campos derivados, orden y paginación ─────────────────

export interface SearchCandidate {
  hipId: string;
  key: string;
  hipNumber: string;
  saleId: string;
  sessionDate: Date | null;
  color: string | null; // ya normalizado
  birthYear: number | null;
  saleStatus: SaleStatus;
  price: number | null;
  aiScore: number | null;
  aiClass: AiClass;
  isFavorite: boolean;
}

function inRange(v: number | null, min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true;
  if (v === null) return false;
  if (min !== undefined && v < min) return false;
  if (max !== undefined && v > max) return false;
  return true;
}

/** Aplica los filtros que dependen de campos derivados. Todos se combinan con Y (AND). */
export function applyDerivedFilters(cands: SearchCandidate[], req: SearchRequest): SearchCandidate[] {
  const reviewed = req.reviewed ? new Set(req.reviewedKeys ?? []) : null;
  return cands.filter((c) => {
    if (req.colors && (!c.color || !req.colors.includes(c.color))) return false;
    if (!inRange(c.birthYear, req.birthYearFrom, req.birthYearTo)) return false;
    if (!inRange(Number(c.hipNumber), req.hipFrom, req.hipTo)) return false;
    if (req.saleStatuses && !req.saleStatuses.includes(c.saleStatus)) return false;
    if (!inRange(c.price, req.priceMin, req.priceMax)) return false;
    if (!inRange(c.aiScore, req.aiScoreMin, req.aiScoreMax)) return false;
    if (req.aiClasses && !req.aiClasses.includes(c.aiClass)) return false;
    if (req.favoritesOnly && !c.isFavorite) return false;
    if (reviewed) {
      const isReviewed = reviewed.has(c.key);
      if (req.reviewed === "REVIEWED" && !isReviewed) return false;
      if (req.reviewed === "NOT_REVIEWED" && isReviewed) return false;
    }
    return true;
  });
}

/**
 * Orden estable y determinista. Los valores que no existen (HIP sin score,
 * sin precio, sin fecha) van SIEMPRE al final, en cualquier dirección.
 * Desempate: fecha de venta, luego número de HIP, luego id.
 */
export function sortCandidates(cands: SearchCandidate[], sort: SearchRequest["sort"]): SearchCandidate[] {
  const dir = sort.direction === "DESC" ? -1 : 1;
  const value = (c: SearchCandidate): number | null => {
    switch (sort.field) {
      case "AI_SCORE": return c.aiScore;
      case "PRICE": return c.price;
      case "SALE_DATE": return c.sessionDate ? c.sessionDate.getTime() : null;
      case "HIP": return null;
    }
  };
  const tieBreak = (a: SearchCandidate, b: SearchCandidate) => {
    const da = a.sessionDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const db = b.sessionDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    const h = compareHipNumbers(a.hipNumber, b.hipNumber);
    if (h !== 0) return h;
    return a.hipId < b.hipId ? -1 : a.hipId > b.hipId ? 1 : 0;
  };
  return [...cands].sort((a, b) => {
    if (sort.field === "HIP") {
      const h = compareHipNumbers(a.hipNumber, b.hipNumber) * dir;
      if (h !== 0) return h;
      return tieBreak(a, b);
    }
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return tieBreak(a, b);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va !== vb) return (va - vb) * dir;
    return tieBreak(a, b);
  });
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
