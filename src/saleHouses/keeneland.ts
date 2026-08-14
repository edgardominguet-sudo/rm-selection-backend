import { NormalizedHip, SaleHouseClient, CatalogMediaItem, CatalogNotYetPublishedError, SaleFetchContext } from "../types";
import { resolveKeenelandHipDates } from "./keenelandSchedule";
import { deriveKeenelandPedigreeSaleCode, probeKeenelandCatalogViaPedigreePdfs } from "./keenelandPedigreePdfCatalog";

// Forma cruda de la API interna de Keeneland
// (GET https://www.keeneland.com/json/sale_api/get/catalog/{saleID}) —
// devuelve un diccionario keyed por ID interno, no un array. Puerto de
// RMSelection/Models/KeenelandHipCatalogEntry.swift.
interface RawEntry {
  field_hip_number: string;
  // `title` (sin prefijo field_, así lo confirmó el modelo iOS
  // KeenelandHipCatalogEntry.swift) suele venir vacío en yearlings que
  // todavía no corrieron — no es un dato faltante, es que el caballo
  // todavía no tiene nombre público registrado.
  title?: string | null;
  field_main_image?: string | null;
  field_sire?: string | null;
  field_dam?: string | null;
  field_broodmare_sire?: string | null;
  field_color?: string | null;
  field_foaling_date?: string | null;
  field_sex?: string | null;
  field_consignor?: string | null;
  field_sale_price?: string | null;
  field_buyer_name?: string | null;
  field_out?: string | null;
  field_video_upload?: unknown[];
  field_other_videos?: unknown[];
}

// El formato exacto de field_foaling_date todavía no se pudo verificar
// contra datos en vivo (catálogo sin publicar al momento de escribir esto,
// 2026-08-12) — se extrae de forma defensiva solo el año de 4 dígitos, sin
// asumir un formato de fecha completo (ISO, MM/DD/YYYY, etc.), para no
// romper si viene en un formato inesperado.
function extractFoalYear(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\d{4}/);
  if (!match) return undefined;
  const year = Number(match[0]);
  return Number.isFinite(year) ? year : undefined;
}

function vimeoEmbedURL(raw: unknown): string | null {
  const str = typeof raw === "string" ? raw : (raw as Record<string, string> | null)?.value ?? (raw as Record<string, string> | null)?.url;
  if (!str) return null;
  const idMatch = str.match(/\d{6,}/);
  if (!idMatch) return null;
  return `https://player.vimeo.com/video/${idMatch[0]}`;
}

function normalize(entry: RawEntry): NormalizedHip {
  const media: CatalogMediaItem[] = [];
  if (entry.field_main_image) {
    media.push({ kind: "photo", url: entry.field_main_image });
  }
  const videoRefs = [...(entry.field_video_upload ?? []), ...(entry.field_other_videos ?? [])];
  for (const ref of videoRefs) {
    const embed = vimeoEmbedURL(ref);
    if (embed) media.push({ kind: "video", url: embed });
  }

  const hasSaleResult = entry.field_sale_price != null || entry.field_buyer_name != null || entry.field_out != null;

  return {
    hipNumber: entry.field_hip_number,
    horseName: entry.title || undefined,
    sex: entry.field_sex ?? undefined,
    consignor: entry.field_consignor ?? undefined,
    sire: entry.field_sire ?? undefined,
    dam: entry.field_dam ?? undefined,
    damSire: entry.field_broodmare_sire ?? undefined,
    color: entry.field_color ?? undefined,
    foalYear: extractFoalYear(entry.field_foaling_date),
    media,
    saleResult: hasSaleResult
      ? {
          priceRaw: entry.field_sale_price ?? undefined,
          purchaser: entry.field_buyer_name ?? undefined,
          soldAsCode: entry.field_out ?? undefined,
        }
      : undefined,
  };
}

// Ver comentario equivalente en fasigTipton.ts: TTL corto a propósito, solo
// para deduplicar el fetchCatalog()+resolveSessionDates() de un mismo
// syncCatalog() — NO para saltear el chequeo real que le toca según
// pollingPolicy la próxima vez que el scheduler vuelva.
const CACHE_TTL_MS = 60_000;

export class KeenelandClient implements SaleHouseClient {
  private cache = new Map<string, { entries: RawEntry[]; fetchedAt: number }>();

  private async fetchRaw(externalSaleId: string): Promise<RawEntry[]> {
    const cached = this.cache.get(externalSaleId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries;

    const url = `https://www.keeneland.com/json/sale_api/get/catalog/${externalSaleId}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    // Mismo criterio que en FasigTiptonClient.fetchRaw: leer como texto
    // primero para que un 200 con body vacío/cortado quede con un mensaje
    // de error que muestre status + los primeros caracteres del body real,
    // en vez de un "Unexpected end of JSON input" ciego.
    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`Keeneland catalog fetch failed (${response.status}) for sale ${externalSaleId}: ${rawBody.slice(0, 500)}`);
    }
    // 200 con body vacío = "todavía no publicamos el catálogo de este
    // sale" (le pasa a Keeneland con sales anunciados con anticipación,
    // ej. "January Horses of All Ages Sale") — no es un error real, ver
    // CatalogNotYetPublishedError en types.ts.
    if (rawBody.trim().length === 0) {
      throw new CatalogNotYetPublishedError("Keeneland", externalSaleId);
    }
    let raw: Record<string, RawEntry>;
    try {
      raw = JSON.parse(rawBody) as Record<string, RawEntry>;
    } catch (err) {
      throw new Error(`Keeneland catalog devolvió un body no-JSON (status ${response.status}) para sale ${externalSaleId}. Primeros 500 caracteres: ${JSON.stringify(rawBody.slice(0, 500))}`);
    }
    const entries = Object.values(raw);
    this.cache.set(externalSaleId, { entries, fetchedAt: Date.now() });
    return entries;
  }

  async fetchCatalog(externalSaleId: string, ctx?: SaleFetchContext): Promise<NormalizedHip[]> {
    try {
      const entries = await this.fetchRaw(externalSaleId);
      return entries.map(normalize);
    } catch (err) {
      // MECANISMO DE RESPALDO (2026-08-14): la API interna de Drupal de
      // Keeneland (arriba) puede seguir "sin publicar" (200 vacío) durante
      // varios días DESPUÉS de que Keeneland ya haya publicado el catálogo
      // real de otra forma — ver keenelandPedigreePdfCatalog.ts para la
      // investigación completa. Se confirmó en vivo que September Yearling
      // Sale 2026 (externalSaleId 12) ya tiene Hips reales (1 a 4650, con
      // huecos) disponibles vía PDF público de pedigree por Hip, mientras
      // que este endpoint seguía devolviendo vacío.
      //
      // Solo se activa cuando: (a) el error es genuinamente "todavía no
      // publicado" (no un 500/timeout real, que debe seguir
      // propagándose); (b) hay contexto de la venta (nombre + año) para
      // derivar el código real de la carpeta de PDFs, sin inventar nada; y
      // (c) esta venta todavía no tiene NINGÚN Hip guardado — el probing
      // completo (miles de PDFs) es pesado, así que corre UNA sola vez
      // (la primera vez que el catálogo aparece disponible). Ciclos
      // siguientes del scheduler: si Drupal se pobló mientras tanto, este
      // mismo catch ya no se dispara (fetchRaw no vuelve a tirar
      // CatalogNotYetPublishedError) y la vía normal retoma el control
      // sola, enriqueciendo lo que ya se importó (upsertNormalizedHips
      // nunca borra, solo agrega/actualiza).
      if (!(err instanceof CatalogNotYetPublishedError)) throw err;
      if (!ctx || ctx.hipCountBeforeSync > 0) throw err;

      const year = ctx.startDate ? ctx.startDate.getUTCFullYear() : null;
      const saleCode = deriveKeenelandPedigreeSaleCode(ctx.name, year);
      if (!saleCode) throw err;

      console.log(`[keeneland] Catálogo interno todavía vacío para "${ctx.name}" — probando mecanismo de respaldo (PDFs de pedigree, carpeta ${saleCode})...`);
      const fallbackHips = await probeKeenelandCatalogViaPedigreePdfs(saleCode, {
        onProgress: (found, lastChecked) => {
          if (lastChecked % 500 === 0) {
            console.log(`[keeneland] Respaldo PDF "${saleCode}": ${found} Hips encontrados, último número probado ${lastChecked}.`);
          }
        },
      });
      if (fallbackHips.length === 0) throw err; // ni el respaldo encontró nada real — se conserva el error original (no inventar un catálogo vacío como si fuera éxito).
      console.log(`[keeneland] Respaldo PDF "${saleCode}" completo: ${fallbackHips.length} Hips reales encontrados para "${ctx.name}".`);
      return fallbackHips;
    }
  }

  // A diferencia de Fasig-Tipton, Keeneland NO trae una fecha directa por
  // Hip en su catálogo (su campo de sesión es solo un número). Para
  // resolverlo igual de forma automática, se lee el programa oficial de
  // la venta (Schedule of Sale) — ver keenelandSchedule.ts.
  async resolveSessionDates(
    _externalSaleId: string,
    _hips: NormalizedHip[],
    opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
  ): Promise<Map<string, Date>> {
    if (!opts.scheduleYear || !opts.scheduleSlug) return new Map();
    return resolveKeenelandHipDates(opts.scheduleYear, _externalSaleId, opts.scheduleSlug);
  }
}
