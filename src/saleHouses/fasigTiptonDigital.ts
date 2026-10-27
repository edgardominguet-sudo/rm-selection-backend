import { db } from "../db";
import { CatalogMediaItem, CatalogNotYetPublishedError, NormalizedHip, ResolvedSaleDay } from "../types";
import { fetchWithRetry } from "../util/httpRetry";
import { DiscoveredSaleAnnouncement } from "./discovery/types";
import { normalizeBredState } from "../catalogNames";

// FASIG-TIPTON DIGITAL (2026-10-27, pedido de Ramon: "las casas tienen
// constantemente ventas digitales, no las veo en nuestra app").
//
// Las ventas digitales de Fasig-Tipton viven en otra plataforma
// (digital.fasigtipton.com) con su propia numeración — NO salen de la API de
// catálogo de las ventas presenciales (comprobado: el "ft_sale_id" 206 de la
// digital de octubre 2026 es otra venta de 2022 en esa API). Cada página
// pública de esa plataforma trae todos sus datos en un bloque JSON
// (atributo `data-page`), el mismo que usa la propia web para dibujarse:
//   - /sales                 -> ventas actuales y próximas ("events")
//   - /sales/sale/{id}       -> la venta con TODOS sus lotes ("listings")
//   - /sales/entry/{id}/...  -> un lote: abuelo materno y PDF de pedigree
//
// En RM Selection una venta digital es una venta más de Fasig-Tipton, con
// externalSaleId "digital-{id}" (nunca choca con los IDs de las
// presenciales) — así todo el resto (catálogo, fotos, pedigree, favoritos,
// análisis, resultados) funciona igual, sin caminos aparte.

export const DIGITAL_SALE_PREFIX = "digital-";
const BASE_URL = "https://digital.fasigtipton.com";

export function isDigitalSaleId(externalSaleId: string | null | undefined): boolean {
  return !!externalSaleId && externalSaleId.startsWith(DIGITAL_SALE_PREFIX);
}

function digitalEventId(externalSaleId: string): string {
  return externalSaleId.slice(DIGITAL_SALE_PREFIX.length);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/** El bloque JSON `data-page` de una página de la plataforma digital. */
export function parseDigitalPage(html: string): { component?: string; props: Record<string, unknown> } | null {
  const match = html.match(/data-page="([^"]+)"/);
  if (!match) return null;
  try {
    return JSON.parse(decodeHtmlAttribute(match[1]));
  } catch {
    return null;
  }
}

async function fetchDigitalPage(path: string) {
  const response = await fetchWithRetry(`${BASE_URL}${path}`, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`Fasig-Tipton Digital ${path}: HTTP ${response.status}`);
  const page = parseDigitalPage(await response.text());
  if (!page) throw new Error(`Fasig-Tipton Digital ${path}: la página no trae el bloque de datos (posible cambio de estructura).`);
  return page;
}

function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

interface DigitalEvent {
  id: number;
  title: string;
  slug?: string;
  start_time: string;
  end_time: string;
  status?: string;
  event_type?: string;
  is_private?: number | boolean;
}

/** Ventas digitales actuales y próximas (las ya cerradas se filtran después). */
export function announcementsFromDigitalEvents(events: DigitalEvent[]): DiscoveredSaleAnnouncement[] {
  const result: DiscoveredSaleAnnouncement[] = [];
  for (const event of events) {
    if (!event?.id || !event.title || event.is_private) continue;
    const start = new Date(event.start_time);
    const end = new Date(event.end_time);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
    result.push({
      name: event.title.trim(),
      externalSaleId: `${DIGITAL_SALE_PREFIX}${event.id}`,
      startDate: start,
      endDate: end,
      announcementUrl: `${BASE_URL}/sales/sale/${event.id}/${event.slug ?? ""}`.replace(/\/$/, ""),
      access: "FULL",
      isDigital: true,
    });
  }
  return result;
}

export async function discoverDigitalSales(): Promise<DiscoveredSaleAnnouncement[]> {
  const page = await fetchDigitalPage("/sales");
  return announcementsFromDigitalEvents(listOf<DigitalEvent>(page.props.events));
}

// ---------------------------------------------------------------- Catálogo

interface DigitalListing {
  id: number;
  lot_number: string;
  lot_number_suffix?: string | null;
  title?: string | null;
  status?: string | null;
  is_sold?: boolean | null;
  sold_price?: string | number | null;
  public_winner_display_name?: string | null;
  end_time?: string | null;
  sex?: string | null;
  color?: string | null;
  sire?: string | null;
  dam?: string | null;
  dob?: string | null;
  foaled?: string | null;
  seller_name?: string | null;
  category_name?: string | null;
  hero?: string | null;
  video?: string | null;
  url?: string | null;
  meta?: { item_videos?: Array<{ attributes?: { src?: string } }> } | null;
}

interface StoredHip {
  hipNumber: string;
  damSire: string | null;
  pedigreePdfUrl: string | null;
  mediaJson: unknown;
}

interface ListingDetail {
  damSire?: string;
  pedigreePdfUrl?: string;
  photos: string[];
}

function lotNumber(listing: DigitalListing): string {
  return `${String(listing.lot_number ?? "").trim()}${(listing.lot_number_suffix ?? "").trim()}`;
}

function parseIsoDay(raw: string | null | undefined): Date | undefined {
  const m = raw?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : undefined;
}

/** Día (hora del este) en que cierra la puja del lote, a las 12:00 ET (16:00 UTC) — convención del resto del backend. */
export function closingDay(endTime: string | null | undefined): Date | undefined {
  if (!endTime) return undefined;
  const end = new Date(endTime);
  if (isNaN(end.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(end)
    .reduce<Record<string, number>>((acc, p) => (p.type === "literal" ? acc : { ...acc, [p.type]: Number(p.value) }), {});
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 16, 0, 0));
}

export function normalizeDigitalListing(listing: DigitalListing, detail: ListingDetail | undefined, now: Date): NormalizedHip {
  const media: CatalogMediaItem[] = [];
  const photos = detail?.photos.length ? detail.photos : listing.hero ? [listing.hero] : [];
  for (const url of photos) media.push({ kind: "photo", url });
  const videos = new Set<string>();
  if (listing.video) videos.add(listing.video.trim());
  for (const v of listing.meta?.item_videos ?? []) if (v.attributes?.src) videos.add(v.attributes.src.trim());
  for (const url of videos) if (/^https?:\/\//.test(url)) media.push({ kind: "video", url });

  const status = (listing.status ?? "").toLowerCase();
  const closed = !!listing.end_time && new Date(listing.end_time).getTime() <= now.getTime();
  const price = listing.sold_price != null ? String(listing.sold_price).replace(/\.0+$/, "") : undefined;
  const saleResult =
    status === "sold" || listing.is_sold
      ? { priceRaw: price, purchaser: listing.public_winner_display_name || undefined }
      : status === "withdrawn"
        ? { soldAsCode: "OUT" }
        : status === "passed" && closed
          ? { soldAsCode: "RNA" }
          : undefined;

  const foalingDate = parseIsoDay(listing.dob);
  return {
    hipNumber: lotNumber(listing),
    horseName: listing.title ?? undefined,
    sex: listing.sex ?? undefined,
    color: listing.color ?? undefined,
    sire: listing.sire ?? undefined,
    dam: listing.dam ?? undefined,
    damSire: detail?.damSire,
    consignor: listing.seller_name ?? undefined,
    bredState: normalizeBredState(listing.foaled) ?? undefined,
    foalingDate,
    foalYear: foalingDate?.getUTCFullYear(),
    pedigreePdfUrl: detail?.pedigreePdfUrl,
    media,
    saleResult,
  };
}

/** Abuelo materno, PDF de pedigree y todas las fotos de un lote (su página propia). */
export function parseListingDetail(page: { props: Record<string, unknown> }): ListingDetail {
  const listing = (page.props.listing ?? {}) as { meta?: { sire_of_dam?: string | null } };
  const docs = (page.props.document_collection ?? {}) as { pedigree?: Array<{ src?: string }> };
  const media = listOf<{ xl?: string; src?: string }>(page.props.media);
  const pdf = docs.pedigree?.find((d) => typeof d.src === "string" && /\.pdf(\?|$)/i.test(d.src))?.src;
  return {
    damSire: listing.meta?.sire_of_dam?.trim() || undefined,
    pedigreePdfUrl: pdf,
    photos: media.map((m) => m.xl ?? m.src).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)),
  };
}

async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

export class FasigTiptonDigitalCatalog {
  private cache = new Map<string, { listings: DigitalListing[]; fetchedAt: number }>();

  private async listings(externalSaleId: string): Promise<DigitalListing[]> {
    const cached = this.cache.get(externalSaleId);
    if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.listings;
    const page = await fetchDigitalPage(`/sales/sale/${digitalEventId(externalSaleId)}`);
    const listings = listOf<DigitalListing>(page.props.listings).filter((l) => l?.lot_number != null);
    if (listings.length === 0) throw new CatalogNotYetPublishedError("Fasig-Tipton Digital", externalSaleId);
    this.cache.set(externalSaleId, { listings, fetchedAt: Date.now() });
    return listings;
  }

  async fetchCatalog(externalSaleId: string): Promise<NormalizedHip[]> {
    const listings = await this.listings(externalSaleId);

    // La página de cada lote (abuelo materno, PDF de pedigree, fotos) se lee
    // UNA sola vez por lote: solo los que todavía no tienen esos datos
    // guardados. Las fotos guardadas se conservan mientras el lote no cambie.
    const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: "FASIG_TIPTON", externalSaleId } }, select: { id: true } });
    const stored: StoredHip[] = sale
      ? await db.hip.findMany({ where: { saleId: sale.id }, select: { hipNumber: true, damSire: true, pedigreePdfUrl: true, mediaJson: true } })
      : [];
    const storedByHip = new Map(stored.map((h: StoredHip) => [h.hipNumber, h] as [string, StoredHip]));

    const details = new Map<string, ListingDetail>();
    const pending = listings.filter((l) => {
      const s = storedByHip.get(lotNumber(l));
      if (s && s.damSire && s.pedigreePdfUrl) {
        const photos = (Array.isArray(s.mediaJson) ? (s.mediaJson as Array<{ kind?: string; url?: string }>) : [])
          .filter((m) => m.kind === "photo" && m.url)
          .map((m) => m.url as string);
        details.set(lotNumber(l), { damSire: s.damSire, pedigreePdfUrl: s.pedigreePdfUrl, photos });
        return false;
      }
      return !!l.url;
    });
    await runLimited(pending, 4, async (listing) => {
      try {
        const page = await fetchDigitalPage(listing.url!);
        details.set(lotNumber(listing), parseListingDetail(page));
      } catch (err) {
        console.error(`[ft-digital] No se pudo leer el lote ${lotNumber(listing)} de ${externalSaleId}:`, err);
      }
    });

    const now = new Date();
    return listings.map((l) => normalizeDigitalListing(l, details.get(lotNumber(l)), now));
  }

  /** Fecha de sesión de cada lote = día en que cierra su puja. */
  async resolveSessionDates(externalSaleId: string): Promise<Map<string, Date>> {
    const map = new Map<string, Date>();
    for (const listing of await this.listings(externalSaleId)) {
      const day = closingDay(listing.end_time);
      if (day) map.set(lotNumber(listing), day);
    }
    return map;
  }

  /** Calendario: un día por fecha de cierre, con la hora de cierre del primer lote. */
  async resolveSaleDays(externalSaleId: string): Promise<ResolvedSaleDay[]> {
    const byDay = new Map<string, { date: Date; hips: number[]; firstClose: Date }>();
    for (const listing of await this.listings(externalSaleId)) {
      const day = closingDay(listing.end_time);
      if (!day || !listing.end_time) continue;
      const key = day.toISOString().slice(0, 10);
      const close = new Date(listing.end_time);
      const bucket = byDay.get(key) ?? { date: day, hips: [], firstClose: close };
      const n = parseInt(lotNumber(listing), 10);
      if (!isNaN(n)) bucket.hips.push(n);
      if (close < bucket.firstClose) bucket.firstClose = close;
      byDay.set(key, bucket);
    }
    return [...byDay.values()]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((b, i) => ({
        date: b.date,
        sessionNumber: i + 1,
        startTimeLabel: b.firstClose
          .toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })
          .toLowerCase(),
        hipRangeStart: b.hips.length ? String(Math.min(...b.hips)) : undefined,
        hipRangeEnd: b.hips.length ? String(Math.max(...b.hips)) : undefined,
        headCount: b.hips.length,
        source: "FT_DIGITAL_CLOSING_TIMES",
      }));
  }
}

export const fasigTiptonDigitalCatalog = new FasigTiptonDigitalCatalog();
