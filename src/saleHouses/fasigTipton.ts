import { NormalizedHip, ResolvedSaleDay, SaleHouseClient, CatalogMediaItem, CatalogNotYetPublishedError } from "../types";
import { resolveSaleDaysFromSessionDates } from "./sessionDateSaleDays";

// Forma cruda de la API interna de Fasig-Tipton
// (GET https://www.fasigtipton.com/django/api/horses/?sale={saleID}).
// Puerto directo de RMSelection/Models/FasigTiptonHipCatalogEntry.swift —
// mismos nombres de campo, misma lógica de armado de media.
interface RawEntry {
  hip: number;
  name?: string | null;
  sex?: string | null;
  sire?: string | null;
  dam?: string | null;
  sire_of_dam?: string | null;
  consignor?: string | null;
  consignor_name?: string | null;
  photo?: string | null;
  generalhorsephoto_set?: { photo: string }[];
  enhancedhorsephoto_set?: { photo: string }[];
  enhanced_photo_caption?: string | null;
  under_tack_show_video?: string | null;
  enhanced_featured_video?: string | null;
  youtube_url?: string | null; // en la práctica, casi siempre un link de Vimeo
  // Fecha de la jornada de venta, "YYYY-MM-DD" — este es el campo que
  // hace que Fasig-Tipton no necesite scraping de programa oficial: la
  // fecha ya viene directa por Hip.
  session?: string | null;
  price?: string | null;
  purchaser?: string | null;
  sold_as_code?: string | null;
}

function buildMedia(entry: RawEntry): CatalogMediaItem[] {
  const items: CatalogMediaItem[] = [];
  const seen = new Set<string>();
  const add = (url: string | null | undefined, kind: "photo" | "video", caption?: string | null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({ kind, url, caption: caption ?? undefined });
  };

  add(entry.photo, "photo");
  for (const item of entry.generalhorsephoto_set ?? []) add(item.photo, "photo");
  for (const item of entry.enhancedhorsephoto_set ?? []) add(item.photo, "photo", entry.enhanced_photo_caption);
  add(entry.youtube_url, "video");
  add(entry.under_tack_show_video, "video");
  add(entry.enhanced_featured_video, "video");

  return items;
}

function normalize(entry: RawEntry): NormalizedHip {
  const hasSaleResult = entry.price != null || entry.purchaser != null || entry.sold_as_code != null;
  return {
    hipNumber: String(entry.hip),
    horseName: entry.name ?? undefined,
    sex: entry.sex ?? undefined,
    consignor: entry.consignor ?? entry.consignor_name ?? undefined,
    sire: entry.sire ?? undefined,
    dam: entry.dam ?? undefined,
    damSire: entry.sire_of_dam ?? undefined,
    media: buildMedia(entry),
    saleResult: hasSaleResult
      ? {
          priceRaw: entry.price ?? undefined,
          purchaser: entry.purchaser ?? undefined,
          soldAsCode: entry.sold_as_code ?? undefined,
        }
      : undefined,
  };
}

// TTL corto (no "cachear para siempre"): syncCatalog() llama fetchCatalog()
// y resolveSessionDates() una atrás de la otra para la misma venta — este
// cache solo evita pedirle la misma respuesta dos veces a Fasig-Tipton en
// esos milisegundos. Con un Map sin vencimiento (como estaba antes), la
// segunda vez que el scheduler vuelve a chequear esta venta (minutos u
// horas después, según pollingPolicy) recibía la MISMA respuesta cacheada
// del primer fetch de todo el proceso — el catálogo nunca se volvía a
// consultar de verdad mientras el servicio siguiera corriendo, así que
// nunca se detectaba una foto/video nuevo. Ver ARCHITECTURE.md.
const CACHE_TTL_MS = 60_000;

export class FasigTiptonClient implements SaleHouseClient {
  private cache = new Map<string, { entries: RawEntry[]; fetchedAt: number }>();

  private async fetchRaw(externalSaleId: string): Promise<RawEntry[]> {
    const cached = this.cache.get(externalSaleId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries;

    const url = `https://www.fasigtipton.com/django/api/horses/?sale=${externalSaleId}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    // Se lee como texto primero (en vez de response.json() directo) a
    // propósito: un 200 con body vacío/cortado (le pasó a Fasig-Tipton
    // alguna vez) hacía que JSON.parse tirara "Unexpected end of JSON
    // input" sin decir nada de qué vino en la respuesta — así, el mensaje
    // de error queda con el status Y los primeros caracteres del body
    // real, para poder diagnosticar sin tener que agregar logs sueltos
    // cada vez que pasa.
    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`Fasig-Tipton catalog fetch failed (${response.status}) for sale ${externalSaleId}: ${rawBody.slice(0, 500)}`);
    }
    // 200 con body vacío = casi siempre "todavía no publicamos el
    // catálogo de este sale", no un error real — se distingue con un
    // tipo de error propio para que el scheduler lo loguee tranquilo en
    // vez de como error (ver CatalogNotYetPublishedError en types.ts).
    if (rawBody.trim().length === 0) {
      throw new CatalogNotYetPublishedError("Fasig-Tipton", externalSaleId);
    }
    let entries: RawEntry[];
    try {
      entries = JSON.parse(rawBody) as RawEntry[];
    } catch (err) {
      throw new Error(`Fasig-Tipton catalog devolvió un body no-JSON (status ${response.status}) para sale ${externalSaleId}. Primeros 500 caracteres: ${JSON.stringify(rawBody.slice(0, 500))}`);
    }
    this.cache.set(externalSaleId, { entries, fetchedAt: Date.now() });
    return entries;
  }

  async fetchCatalog(externalSaleId: string): Promise<NormalizedHip[]> {
    const entries = await this.fetchRaw(externalSaleId);
    return entries.map(normalize);
  }

  // Fasig-Tipton ya trae la fecha de sesión directa en cada Hip del
  // catálogo (campo "session", "YYYY-MM-DD") — no hace falta ningún paso
  // extra de red ni de scraping, a diferencia de Keeneland.
  async resolveSessionDates(externalSaleId: string): Promise<Map<string, Date>> {
    const entries = await this.fetchRaw(externalSaleId);
    const result = new Map<string, Date>();
    for (const entry of entries) {
      if (!entry.session) continue;
      const date = new Date(`${entry.session}T12:00:00-04:00`); // mediodía ET para evitar corrimientos de día por huso horario
      if (!isNaN(date.getTime())) {
        result.set(String(entry.hip), date);
      }
    }
    return result;
  }

  // Calendario de Ventas para Fasig-Tipton (implementado 2026-08-15, a
  // pedido: "utilizando exactamente el mismo funcionamiento, diseño y
  // ubicación que ya está implementado para Keeneland"). A diferencia de
  // Keeneland, acá no hace falta ningún scraping de programa oficial: el
  // campo "session" que ya trae cada Hip del catálogo (ver
  // resolveSessionDates arriba) es fuente suficiente y real para agrupar
  // por día — se reutiliza el mismo dato, sin pedirlo dos veces.
  async resolveSaleDays(
    externalSaleId: string,
    _opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
  ): Promise<ResolvedSaleDay[]> {
    const sessionDates = await this.resolveSessionDates(externalSaleId);
    return resolveSaleDaysFromSessionDates(sessionDates, "FASIG_TIPTON_CATALOG_SESSION_FIELD");
  }
}
