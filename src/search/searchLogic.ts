// Search por venta (2026-09-27, reestructuración pedida por Ramon: "la nueva
// ventana Search debe ser SIMPLE y contener ÚNICAMENTE estos filtros":
// Sire, Dam, Grand Sire, Broodmare Sire, Date of Birth (desde/hasta), Sex,
// Color y Consignor — siempre dentro de UNA venta, con los valores
// disponibles de esa venta). Módulo puro, sin base de datos: validación del
// pedido y reglas de negocio que se prueban con tests unitarios.
//
// Reemplaza a la búsqueda avanzada multi-venta anterior (búsqueda rápida,
// filtros de venta/año/libro/sesión, precio, AI Score, clasificación,
// favoritos, revisado, orden configurable). De esa versión se conservan,
// sin cambios, las reglas ya verificadas con datos reales: normalización de
// color, resultado de venta (misma regla que la app), precio, AI Score
// (misma fuente única que el Ranking del Día) y clasificación.
import { HttpError } from "../api/errorHandler";
import { rankingScoreFromAnalysis, compareHipNumbers, RankingAnalysisInput } from "../rankingSelection";

/** Orden de HIP: misma regla única que el Ranking del Día. */
export const compareHips = compareHipNumbers;
import { CLASSIFICATION_THRESHOLDS } from "../analysis/conformationScores";

export const SEARCH_DEFAULT_PAGE_SIZE = 50;
export const SEARCH_MAX_PAGE_SIZE = 100;
const MAX_TEXT_LENGTH = 120;
const MAX_LIST_LENGTH = 300;

export const SALE_STATUSES = ["SOLD", "RNA", "OUT", "NO_RESULT"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export type AiClass = "EXCELENTE" | "BIEN" | "REVISAR" | "NOT_ANALYZED";

/** Colores canónicos (la fuente mezcla "B", "Bay", "DB/BR", "Dark Bay or Brown"...). */
export const CANONICAL_COLORS = ["Bay", "Dark Bay/Brown", "Chestnut", "Gray/Roan", "Black"] as const;
export const SEXES = ["C", "F", "G", "R", "M"] as const;

export interface SaleSearchRequest {
  house: string;
  externalSaleId: string;
  sires?: string[];
  dams?: string[];
  grandsires?: string[];
  broodmareSires?: string[];
  consignors?: string[];
  sexes?: string[];
  colors?: string[];
  bredStates?: string[]; // "KY", "FL"... (2026-09-28)
  dobFrom?: string; // YYYY-MM-DD
  dobTo?: string; // YYYY-MM-DD
  page: number;
  pageSize: number;
}

function bad(message: string): never {
  throw new HttpError(400, message, "INVALID_SEARCH");
}

function reqText(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) bad(`'${name}' es obligatorio.`);
  const t = v.trim();
  if (t.length > MAX_TEXT_LENGTH) bad(`'${name}' es demasiado largo.`);
  return t;
}

function optStringList(v: unknown, name: string, allowed?: readonly string[]): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) bad(`'${name}' debe ser una lista.`);
  if (v.length > MAX_LIST_LENGTH) bad(`'${name}' tiene demasiados valores.`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !x.trim() || x.trim().length > MAX_TEXT_LENGTH) bad(`'${name}' contiene un valor inválido.`);
    const t = x.trim();
    if (allowed && !allowed.includes(t)) bad(`'${name}' contiene un valor no permitido: ${t}.`);
    if (!out.includes(t)) out.push(t);
  }
  return out.length ? out : undefined;
}

function optDay(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    bad(`'${name}' debe ser una fecha AAAA-MM-DD.`);
  }
  return v;
}

function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) bad(`'${name}' debe ser un entero entre ${min} y ${max}.`);
  return v;
}

/** Valida el pedido de búsqueda de UNA venta. Errores -> HttpError 400 "INVALID_SEARCH". */
export function parseSaleSearchRequest(body: unknown): SaleSearchRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("El pedido de búsqueda debe ser un objeto JSON.");
  const b = body as Record<string, unknown>;
  const req: SaleSearchRequest = {
    house: reqText(b.house, "house"),
    externalSaleId: reqText(b.externalSaleId, "externalSaleId"),
    sires: optStringList(b.sires, "sires"),
    dams: optStringList(b.dams, "dams"),
    grandsires: optStringList(b.grandsires, "grandsires"),
    broodmareSires: optStringList(b.broodmareSires, "broodmareSires"),
    consignors: optStringList(b.consignors, "consignors"),
    sexes: optStringList(b.sexes, "sexes", SEXES),
    colors: optStringList(b.colors, "colors", CANONICAL_COLORS),
    bredStates: optStringList(b.bredStates, "bredStates")?.map((v) => {
      const code = v.toUpperCase();
      if (!/^[A-Z]{2,4}$/.test(code)) bad(`'bredStates' contiene un valor inválido: ${v}.`);
      return code;
    }),
    dobFrom: optDay(b.dobFrom, "dobFrom"),
    dobTo: optDay(b.dobTo, "dobTo"),
    page: optInt(b.page, "page", 1, 100000) ?? 1,
    pageSize: optInt(b.pageSize, "pageSize", 1, SEARCH_MAX_PAGE_SIZE) ?? SEARCH_DEFAULT_PAGE_SIZE,
  };
  if (req.dobFrom && req.dobTo && req.dobFrom > req.dobTo) bad("'dobFrom' no puede ser posterior a 'dobTo'.");
  return req;
}

/**
 * Clave de comparación de un nombre (Sire/Dam/Consignor...): sin espacios
 * de más y en mayúsculas — cada casa de ventas escribe distinto el mismo
 * nombre ("Into Mischief" / "INTO MISCHIEF"). La misma regla se usa en SQL
 * (upper(btrim(...))) para agrupar las opciones y para filtrar.
 */
export function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

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
  const purchaser = (result.purchaser ?? "").trim().toUpperCase();
  // Un precio "0.00" no es una venta: Fasig-Tipton publica así los retiros
  // (priceRaw "0.00", purchaser "OUT", soldAsCode "Y" — 111 Hips reales).
  const priceNumber = Number((result.priceRaw ?? "").replace(/[$,\s]/g, ""));
  const hasPrice = (result.priceRaw ?? "").trim() !== "" && Number.isFinite(priceNumber) && priceNumber > 0;
  const withdrawn = ["OUT", "SCRATCHED", "WD", "WITHDRAWN"];
  if (code === "RNA") return "RNA";
  if (code === "PS" && hasPrice) return "SOLD";
  if (withdrawn.includes(code) && !hasPrice) return "OUT";
  if (hasPrice) return "SOLD";
  if (withdrawn.includes(purchaser)) return "OUT";
  if (code === "PS") return "SOLD";
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
