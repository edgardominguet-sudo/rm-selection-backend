import { NormalizedHip, SaleHouseClient, CatalogMediaItem, CatalogNotYetPublishedError, SaleFetchContext, ResolvedSaleDay } from "../types";
import { resolveKeenelandHipDates } from "./keenelandSchedule";
import { deriveKeenelandPedigreeSaleCode, probeKeenelandCatalogViaPedigreePdfs } from "./keenelandPedigreePdfCatalog";
import { resolveKeenelandSaleDays } from "./keenelandHipGrouping";

// Forma cruda de la API interna de Keeneland
// (GET https://www.keeneland.com/json/sale_api/get/catalog/{saleID}) —
// devuelve un diccionario keyed por ID interno, no un array. Puerto de
// RMSelection/Models/KeenelandHipCatalogEntry.swift.
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

      const url = `https://www.keeneland.com/json/sale_api/get/catalog/${externalSaleId}`;
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
