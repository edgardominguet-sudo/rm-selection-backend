import { NormalizedHip, SaleHouseClient, CatalogMediaItem, CatalogNotYetPublishedError, SaleFetchContext, ResolvedSaleDay } from "../types";
import { resolveKeenelandHipDates } from "./keenelandSchedule";
import { deriveKeenelandPedigreeSaleCode, probeKeenelandCatalogViaPedigreePdfs } from "./keenelandPedigreePdfCatalog";
import { resolveKeenelandSaleDays } from "./keenelandHipGrouping";

// CORRECCION DE RAIZ (2026-09-03, a pedido explicito de Ramon: "HIP 3 y
// HIP 17 YA tienen foto y Walking Video disponibles, ¿por que ustedes no lo
// detectan?"): la API vieja de abajo (GET .../json/sale_api/get/catalog/12)
// esta MUERTA — nunca devolvio nada real para "September Yearling Sale"
// desde que se cablearo (confirmado: 22 corridas nocturnas seguidas del
// barrido de Media, TODAS con 0 Hips revisados; y confirmado de nuevo hoy
// consultando la URL en vivo, sigue vacia). Keeneland migro su catalogo en
// vivo a un sistema nuevo: la propia pagina de catalogo de
// keeneland.com ("Online Catalog", https://www.keeneland.com/sales/{año}/
// {id}/{slug}/catalog-table/) hoy consume
// https://catalog-backend.keeneland.com/sites/default/files/json_hde/sale_data_{ID}.json
// — un JSON ESTATICO PUBLICO (sin autenticacion, confirmado con un fetch()
// real desde esa misma pagina) con la MISMA forma de RawEntry de siempre
// (mismos field_* de abajo, mismo "diccionario keyed por ID interno, no un
// array") pero bajo un ID NUMERICO DISTINTO al que ya usamos como
// externalSaleId estable (identificado en pantalla/URL del sitio, ej. "12"
// para September Yearling Sale) — probablemente el node id interno real de
// Drupal vs. el alias/slug id que sí quedo estable en la URL publica. Para
// September Yearling Sale 2026: externalSaleId "12" (el de siempre, el que
// ya usan cliente+backend+DB — NO SE TOCA) corresponde a
// CATALOG_BACKEND_SALE_ID "132" (confirmado real: mismo total de Hips —
// 4642 — y mismos datos de Hip 3 -Barn 19, Paramount Sales Agent LXXVIII,
// Gun Runner-Ready Lady- que ya teniamos importados). Verificado con datos
// REALES no vacios de otros 2 Hips de esta misma venta (1325 y 2938, los
// unicos con Media publicada hoy): field_main_image trae una URL de foto
// absoluta lista para usar, field_other_videos trae la URL del reproductor
// de Vimeo completa (".../video/{id}?share=copy") — vimeoEmbedURL() de mas
// abajo ya extrae el ID numerico de CUALQUIER string que se le pase via
// regex, asi que sigue funcionando sin cambios contra este formato nuevo.
// UNICO dato que cambio de forma: field_hip_number viene con CEROS A LA
// IZQUIERDA ("0003" en vez de "3") — normalize() de abajo ya lo despoja.
// DISEÑO: el mapeo es opt-in por externalSaleId (CATALOG_BACKEND_SALE_ID) —
// si una venta de Keeneland no esta en el mapa, sigue exactamente igual que
// antes (API vieja) hasta confirmar a mano su ID real en este sistema
// nuevo, mismo criterio ya usado en SaleOption.swift para cada externalSaleId
// (nunca autodetectado, siempre confirmado y hardcodeado a mano por venta).
const CATALOG_BACKEND_SALE_ID: Record<string, string> = {
    "12": "132", // September Yearling Sale 2026 — ver comentario arriba.
};

// Forma cruda de la API interna de Keeneland — misma forma para la API
// vieja (GET https://www.keeneland.com/json/sale_api/get/catalog/{saleID})
// y para el JSON estatico nuevo de catalog-backend.keeneland.com (ver
// comentario arriba). Devuelve un diccionario keyed por ID interno, no un
// array. Puerto de RMSelection/Models/KeenelandHipCatalogEntry.swift.
interface RawEntry {
    field_hip_number: string;
    title?: string | null;
    field_main_image?: string | null;
    field_sire?: string | null;
    field_dam?: string | null;
    field_broodmare_sire?: string | null;
    field_color?: string | null;
    field_foaling_date?: string | null;
    field_sex?: string | null;
    field_consignor?: string | null;
    field_barns?: string[] | null;
    field_sale_price?: string | null;
    field_buyer_name?: string | null;
    field_out?: string | null;
    field_video_upload?: unknown[];
    field_other_videos?: unknown[];
}

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

function normalizeHipNumber(raw: string): string {
    // El JSON nuevo de catalog-backend.keeneland.com rellena con ceros a
    // la izquierda ("0003") — el resto de RM Selection (DB, cliente,
    // comparaciones por hipNumber) siempre trabajo con el numero sin
    // relleno ("3"), asi que se normaliza en un solo lugar, ni bien se lee
    // el dato crudo. parseInt ignora ceros a la izquierda solo; si por
    // algun motivo el Hip tiene una letra (ej. "17A"), se conserva tal cual
    // (Number() daria NaN y no se debe perder el sufijo).
    const trimmed = raw.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && String(numeric) !== "NaN" && /^\d+$/.test(trimmed)) {
        return String(numeric);
    }
    return trimmed.replace(/^0+(?=\d)/, "");
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
        hipNumber: normalizeHipNumber(entry.field_hip_number),
        horseName: entry.title || undefined,
        sex: entry.field_sex ?? undefined,
        consignor: entry.field_consignor ?? undefined,
        barn: entry.field_barns?.[0] ?? undefined,
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

const CACHE_TTL_MS = 60_000;

export class KeenelandClient implements SaleHouseClient {
    private cache = new Map<string, { entries: RawEntry[]; fetchedAt: number }>();

  private async fetchRaw(externalSaleId: string): Promise<RawEntry[]> {
        const cached = this.cache.get(externalSaleId);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries;

      // Ver comentario grande arriba de RawEntry: preferimos el catalogo
      // en vivo NUEVO cuando ya confirmamos a mano el ID real de esta
      // venta en ese sistema; si no esta en el mapa, mismo camino de
      // siempre (API vieja) para no romper ninguna venta ya funcionando.
      const catalogBackendId = CATALOG_BACKEND_SALE_ID[externalSaleId];
      const url = catalogBackendId
                ? `https://catalog-backend.keeneland.com/sites/default/files/json_hde/sale_data_${catalogBackendId}.json`
                : `https://www.keeneland.com/json/sale_api/get/catalog/${externalSaleId}`;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        const rawBody = await response.text();
        if (!response.ok) {
                throw new Error(`Keeneland catalog fetch failed (${response.status}) for sale ${externalSaleId}: ${rawBody.slice(0, 500)}`);
        }
        if (rawBody.trim().length === 0) {
                throw new CatalogNotYetPublishedError("Keeneland", externalSaleId);
        }
        let raw: Record<string, RawEntry>;
        try {
                raw = JSON.parse(rawBody) as Record<string, RawEntry>;
        } catch (err) {
                throw new Error(`Keeneland catalog devolvio un body no-JSON (status ${response.status}) para sale ${externalSaleId}. Primeros 500 caracteres: ${JSON.stringify(rawBody.slice(0, 500))}`);
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
                if (!(err instanceof CatalogNotYetPublishedError)) throw err;
                // CORRECCION 2026-08-17: forcePdfProbe (ver SaleFetchContext en
          // types.ts) permite volver a correr este respaldo aunque la venta ya
          // tenga Hips - solo cuando se pide explicitamente via resync manual,
          // nunca en el ciclo automatico del scheduler. Necesario para poder
          // recorregir campos (ej. Barn) sobre Hips ya importados cuando se
          // arregla un bug de extraccion DESPUES del import inicial.
          if (!ctx || (ctx.hipCountBeforeSync > 0 && !ctx.forcePdfProbe)) throw err;

          const year = ctx.startDate ? ctx.startDate.getUTCFullYear() : null;
                const saleCode = deriveKeenelandPedigreeSaleCode(ctx.name, year);
                if (!saleCode) throw err;

          console.log(`[keeneland] Catalogo interno todavia vacio para "${ctx.name}" - probando mecanismo de respaldo (PDFs de pedigree, carpeta ${saleCode})...`);
                const fallbackHips = await probeKeenelandCatalogViaPedigreePdfs(saleCode, {
                          onProgress: (found, lastChecked) => {
                                      if (lastChecked % 500 === 0) {
                                                    console.log(`[keeneland] Respaldo PDF "${saleCode}": ${found} Hips encontrados, ultimo numero probado ${lastChecked}.`);
                                      }
                          },
                });
                if (fallbackHips.length === 0) throw err;
                console.log(`[keeneland] Respaldo PDF "${saleCode}" completo: ${fallbackHips.length} Hips reales encontrados para "${ctx.name}".`);
                return fallbackHips;
        }
  }

  async resolveSessionDates(
        _externalSaleId: string,
        _hips: NormalizedHip[],
        opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
      ): Promise<Map<string, Date>> {
        if (!opts.scheduleYear || !opts.scheduleSlug) return new Map();
        return resolveKeenelandHipDates(opts.scheduleYear, _externalSaleId, opts.scheduleSlug);
  }

  async resolveSaleDays(
        externalSaleId: string,
        opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
      ): Promise<ResolvedSaleDay[]> {
        if (!opts.scheduleYear || !opts.scheduleSlug) return [];
        return resolveKeenelandSaleDays(opts.scheduleYear, externalSaleId, opts.scheduleSlug);
  }
}
