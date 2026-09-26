import {
  CatalogMediaItem,
  CatalogNotYetPublishedError,
  NormalizedHip,
  ResolvedSaleDay,
  SaleHouseClient,
  SaleResultData,
} from "../types";
import { fetchWithRetry } from "../util/httpRetry";
import { resolveSaleDaysFromSessionDates } from "./sessionDateSaleDays";
import { parseFoalingDate } from "./dateParsing";

// OBS (Ocala Breeders' Sales) — integración real de catálogo (2026-09-26).
//
// Hasta acá, OBS quedó como MANUAL_CSV porque una investigación anterior
// (2026-08-05) solo encontró el sistema LEGADO de OBS (obscatalog.com,
// ventas viejas): esa página incrusta los datos como un array de
// JavaScript embebido en el HTML (`var arrData = [...]`), sin ningún
// endpoint real detrás — correctamente, no había forma de automatizarlo.
//
// Lo que esa investigación no pudo ver es que OBS ya había migrado (para
// ventas nuevas, incluida October 2026) a `obssales.com/catalog`, una SPA
// en Angular con su propia API REST pública en JSON. Verificado en vivo
// (2026-09-26) contra OBS October (`sale_id: "155"`): 378 Hips, 2
// sesiones, fechas, resultados y media, todos con la estructura exacta
// que se usa acá abajo — ver diagnóstico completo en el documento
// entregado a Ramon el mismo día. `robots.txt` de obssales.com no
// restringe `/wp-json/` ni `/catalog/` (solo bloquea `/wp-admin/`); no se
// encontró ningún Término de Uso que lo prohíba. El endpoint no es un
// contrato publicado oficialmente por OBS (es la API interna que consume
// su propia SPA) — por eso MANUAL_CSV se conserva como respaldo: si este
// endpoint cambia de forma o deja de responder, una venta de OBS puede
// pasar a MANUAL_CSV sin perder nada de lo demás (ver
// saleHouses/manualCatalogImport.ts, mismo NormalizedHip de siempre).
//
// Esta integración es EXCLUSIVAMENTE sobre cómo entra el catálogo: no
// toca ninguna regla de Media ni de Análisis IA (esas siguen dependiendo
// de activeSaleService.ts / mediaSweepService.ts, sin ningún caso
// especial para OBS — ver comentario ahí).

// Forma cruda de la API pública de OBS
// (GET https://obssales.com/wp-json/obs-catalog-wp-plugin/v1/horse-sales/{sale_id}?is_digital=false).
// Solo se tipan los campos que en efecto se usan acá — el objeto real
// trae muchos más (verificado con un dump completo de un Hip real de OBS
// October, 2026-09-26).
interface RawHip {
  hip_number: string;
  horse_name?: string | null;
  sex?: string | null;
  color?: string | null;
  foaling_date?: string | null; // "MM/DD/YYYY" -- mismo formato que ya soporta parseFoalingDate.
  foaling_year?: string | null;
  sire_name?: string | null;
  dam_name?: string | null;
  dam_sire?: string | null;
  consignor_name?: string | null;
  barn_number?: string | null;
  session_number?: string | null;
  in_out_status?: string | null; // "I" (en venta) | "O" (retirado/scratch).
  hammer_price?: string | number | null;
  buyer_name?: string | null;
  rna_summary_indicator?: string | null;
  photo_link?: string | null;
  walk_video_link?: string | null;
  // Booleans ya calculados por OBS mismo para el estado de cada Hip — más
  // confiables que tratar de inferirlo a mano de los campos crudos de
  // arriba (ver buildSaleResult). No siempre viene presente en cada Hip
  // (ej. antes de publicarse el catálogo completo), por eso todo opcional.
  display_props?: {
    is_hip_out?: boolean;
    is_hip_sold?: boolean;
    is_rna?: boolean;
  } | null;
}

interface RawSaleMetaRow {
  meta_key: string;
  meta_value: string;
}

interface RawSaleResponse {
  sale_id: string;
  sale_starts?: string | null;
  sale_ends?: string | null;
  sale_meta?: RawSaleMetaRow[];
  sale_hip?: RawHip[];
}

function buildMedia(entry: RawHip): CatalogMediaItem[] {
  const items: CatalogMediaItem[] = [];
  if (entry.photo_link) items.push({ kind: "photo", url: entry.photo_link });
  // OBS October no trae un video de "under tack show" separado (esta venta
  // no es una de 2 años bajo silla) — solo walk_video_link, verificado
  // contra los nombres de campo de los 378 Hips reales.
  if (entry.walk_video_link) items.push({ kind: "video", url: entry.walk_video_link, caption: "Walking Video" });
  return items;
}

// Arma el resultado de venta (precio/comprador/código) a partir de los
// booleans que OBS ya calculó (display_props) más los campos crudos de
// respaldo (in_out_status, buyer_name) — mismo criterio de
// classifyResultCode (officialSaleResultService.ts): `purchaser` con el
// texto "OUT"/"RNA" dispara directamente la clasificación correcta, sin
// tener que adivinar un código propio de OBS.
function buildSaleResult(entry: RawHip): SaleResultData | undefined {
  const dp = entry.display_props ?? undefined;
  const buyerName = entry.buyer_name?.trim();
  const isOut = dp?.is_hip_out === true || entry.in_out_status === "O";
  const isRna = dp?.is_rna === true;
  // NOTA (2026-09-26): el catálogo de OBS también trae un campo `is_bt`
  // ("is_bt_y_na") -- descartado a propósito acá. Verificado contra los
  // 378 Hips reales de OBS October ANTES de que la venta ocurra: 15 Hips
  // ya traen is_bt=true mientras los 378 siguen "is_hip_not_through_ring_
  // yet=true" (ninguno pasó por el ring, ninguno vendido/RNA/retirado
  // todavía) -- así que `is_bt` NO puede significar "bought back"
  // (resultado de venta), es un dato de catálogo previo a la subasta cuyo
  // significado real no está confirmado. Mismo criterio de "nunca
  // inventar" que el resto del backend: se ignora para el resultado de
  // venta en vez de adivinarle un significado.

  let purchaser: string | undefined;
  if (isOut) purchaser = "OUT";
  else if (isRna) purchaser = "RNA";
  else if (buyerName) purchaser = buyerName;

  const priceRaw = entry.hammer_price != null ? String(entry.hammer_price) : undefined;
  const soldAsCode = entry.rna_summary_indicator?.trim() || undefined;

  if (purchaser === undefined && priceRaw === undefined && soldAsCode === undefined) return undefined;
  return { priceRaw, purchaser, soldAsCode };
}

function normalize(entry: RawHip): NormalizedHip {
  const foalYearRaw = entry.foaling_year ? parseInt(entry.foaling_year, 10) : NaN;
  return {
    hipNumber: String(entry.hip_number),
    horseName: entry.horse_name?.trim() || undefined,
    sex: entry.sex ?? undefined,
    consignor: entry.consignor_name?.trim() || undefined,
    barn: entry.barn_number ?? undefined,
    sire: entry.sire_name?.trim() || undefined,
    dam: entry.dam_name?.trim() || undefined,
    damSire: entry.dam_sire?.trim() || undefined,
    foalYear: !isNaN(foalYearRaw) ? foalYearRaw : undefined,
    foalingDate: parseFoalingDate(entry.foaling_date),
    color: entry.color ?? undefined,
    media: buildMedia(entry),
    saleResult: buildSaleResult(entry),
  };
}

// Nombres de mes en inglés, para leer la fecha de cada sesión desde el
// campo de texto que trae OBS (ver parseSessionDateMap) -- mismo criterio
// tolerante (case-insensitive, con o sin punto) que el resto del backend.
const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

interface RawSessionMeta {
  number: string;
  name: string;
}

// El año de la venta no viene en `sale_sessions` (solo "October 6th", sin
// año) -- se toma de `sale_starts`/`sale_ends` (top-level, formato
// "YYYY-MM-DD HH:MM:SS"), que sí lo trae. Nunca inventado: sin ninguno de
// los dos campos, no hay año del que partir.
function parseSaleYear(sale: RawSaleResponse): number | null {
  const raw = sale.sale_starts ?? sale.sale_ends ?? "";
  const match = /^(\d{4})-/.exec(raw);
  return match ? parseInt(match[1], 10) : null;
}

// `sale_meta.sale_sessions` (JSON serializado como STRING dentro de un
// meta_key más, estilo WordPress -- verificado 2026-09-26 contra OBS
// October) trae, por sesión, un nombre legible tipo "October 6th (Hips 1 -
// 189 + Supplements)". Nunca un campo de fecha estructurado aparte -- se
// extrae "Mes Día" de ese texto (con el año ya resuelto por
// parseSaleYear) y se arma la fecha al mediodía UTC, mismo criterio que
// toNoonUTCDate en dateParsing.ts. Una sesión cuyo nombre no matchee
// ningún mes válido simplemente no entra al mapa -- nunca se inventa.
function parseSessionDateMap(sale: RawSaleResponse): Map<string, Date> {
  const result = new Map<string, Date>();
  const metaRow = sale.sale_meta?.find((m) => m.meta_key === "sale_sessions");
  if (!metaRow) return result;

  const year = parseSaleYear(sale);
  if (year === null) return result;

  let sessions: RawSessionMeta[];
  try {
    sessions = JSON.parse(metaRow.meta_value) as RawSessionMeta[];
  } catch {
    return result;
  }

  const dayRegex = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?/;
  for (const session of sessions) {
    const match = dayRegex.exec(session.name ?? "");
    if (!match) continue;
    const monthIndex = MONTHS[match[1].toLowerCase()];
    if (monthIndex === undefined) continue;
    const day = parseInt(match[2], 10);
    if (isNaN(day)) continue;
    result.set(session.number, new Date(Date.UTC(year, monthIndex, day, 12, 0, 0)));
  }
  return result;
}

// Mismo criterio que FasigTiptonClient: TTL corto (no "cachear para
// siempre"), solo para que fetchCatalog() y resolveSessionDates() de la
// MISMA pasada de syncCatalog() no le pidan dos veces seguidas la misma
// respuesta a OBS -- ver comentario completo en fasigTipton.ts.
const CACHE_TTL_MS = 60_000;

const OBS_API_BASE = "https://obssales.com/wp-json/obs-catalog-wp-plugin/v1";

export class OBSClient implements SaleHouseClient {
  private cache = new Map<string, { sale: RawSaleResponse; fetchedAt: number }>();

  private async fetchRaw(externalSaleId: string): Promise<RawSaleResponse> {
    const cached = this.cache.get(externalSaleId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.sale;

    const url = `${OBS_API_BASE}/horse-sales/${encodeURIComponent(externalSaleId)}?is_digital=false`;
    const response = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    // Igual criterio que Fasig-Tipton: se lee como texto primero, para que
    // un body vacío o cortado no tire un "Unexpected end of JSON input"
    // sin contexto.
    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`OBS catalog fetch failed (${response.status}) for sale ${externalSaleId}: ${rawBody.slice(0, 500)}`);
    }
    if (rawBody.trim().length === 0) {
      throw new CatalogNotYetPublishedError("OBS", externalSaleId);
    }
    let sale: RawSaleResponse;
    try {
      sale = JSON.parse(rawBody) as RawSaleResponse;
    } catch {
      throw new Error(
        `OBS catalog devolvió un body no-JSON (status ${response.status}) para sale ${externalSaleId}. Primeros 500 caracteres: ${JSON.stringify(rawBody.slice(0, 500))}`
      );
    }
    this.cache.set(externalSaleId, { sale, fetchedAt: Date.now() });
    return sale;
  }

  async fetchCatalog(externalSaleId: string): Promise<NormalizedHip[]> {
    const sale = await this.fetchRaw(externalSaleId);
    return (sale.sale_hip ?? []).map(normalize);
  }

  // OBS trae el número de sesión directo en cada Hip (`session_number`) --
  // no hace falta ningún scraping de programa oficial como en Keeneland.
  // Lo único que hay que resolver es la FECHA de cada número de sesión,
  // que sale de sale_meta (ver parseSessionDateMap).
  async resolveSessionDates(externalSaleId: string): Promise<Map<string, Date>> {
    const sale = await this.fetchRaw(externalSaleId);
    const sessionDateBySessionNumber = parseSessionDateMap(sale);
    const result = new Map<string, Date>();
    for (const entry of sale.sale_hip ?? []) {
      if (!entry.session_number) continue;
      const date = sessionDateBySessionNumber.get(entry.session_number);
      if (date) result.set(String(entry.hip_number), date);
    }
    return result;
  }

  // Calendario de Ventas para OBS -- mismo mecanismo genérico que ya usa
  // Fasig-Tipton (resolveSaleDaysFromSessionDates), reutilizando las
  // fechas por Hip ya resueltas arriba, sin pedirlas de nuevo.
  async resolveSaleDays(externalSaleId: string): Promise<ResolvedSaleDay[]> {
    const sessionDates = await this.resolveSessionDates(externalSaleId);
    return resolveSaleDaysFromSessionDates(sessionDates, "OBS_CATALOG_SESSION_FIELD");
  }
}
