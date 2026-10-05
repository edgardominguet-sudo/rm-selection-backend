import { NormalizedHip, ResolvedSaleDay, SaleHouseClient, CatalogMediaItem, CatalogNotYetPublishedError } from "../types";
import { fetchWithRetry } from "../util/httpRetry";
import { resolveSaleDaysFromSessionDates } from "./sessionDateSaleDays";
import { parseFoalingDate } from "./dateParsing";
import { normalizeBredState } from "../catalogNames";

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
  barn?: string | null;
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
  // Fecha de nacimiento completa — PESE AL NOMBRE, el campo real de fecha
  // no es "foaled" (ese trae el ESTADO de nacimiento, ej. "NY") sino este,
  // "year_of_birth", con la fecha completa "MM/DD/YYYY" (ej. "03/27/2025")
  // — confirmado con datos reales de una venta en vivo (2026-09-07, ver
  // dateParsing.ts).
  year_of_birth?: string | null;
  // Color ("B", "CH", "DK B/", "GR/RO"...) y ESTADO de nacimiento ("CA",
  // "KY", "NY"...) — publicados por Fasig-Tipton en su propio catálogo
  // oficial (confirmado con California Fall Yearlings, 2026-09-28: 289/289
  // con ambos datos). Antes no se leían y en Search quedaban "No disponible".
  color?: string | null;
  foaled?: string | null;
  // RETIRADO / SCRATCH (2026-10-04, caso real Saratoga Fall Mixed: 17 HIPs
  // con out=true en fasigtipton.com y 0 OUT en la app). Fasig-Tipton marca
  // el retiro con este booleano (+ out_date), NO con purchaser ni con
  // sold_as_code — sold_as_code es el TIPO de lote ("Y" yearling, "W"
  // weanling, "B" broodmare…), no un resultado.
  out?: boolean | null;
  out_date?: string | null;
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
  const isOut = entry.out === true;
  const hasSaleResult = isOut || entry.price != null || entry.purchaser != null || entry.sold_as_code != null;
  return {
    hipNumber: String(entry.hip),
    horseName: entry.name ?? undefined,
    sex: entry.sex ?? undefined,
    consignor: entry.consignor ?? entry.consignor_name ?? undefined,
    barn: entry.barn ?? undefined,
    sire: entry.sire ?? undefined,
    dam: entry.dam ?? undefined,
    damSire: entry.sire_of_dam ?? undefined,
    foalingDate: parseFoalingDate(entry.year_of_birth),
    color: entry.color?.trim() || undefined,
    bredState: normalizeBredState(entry.foaled) ?? undefined,
    media: buildMedia(entry),
    saleResult: hasSaleResult
      ? {
          priceRaw: entry.price ?? undefined,
          purchaser: isOut ? "OUT" : entry.purchaser ?? undefined,
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
    // CORRECCION 2026-09-15 (a pedido explicito de Ramon, mismo criterio que
    // Keeneland -- ver util/httpRetry.ts para la investigacion completa):
    // reintenta unas pocas veces con backoff corto ante un 5xx transitorio en vez
    // de perder el ciclo de 10 minutos completo del precio en vivo.
    const response = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
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
  async resolveSessionDates(
    externalSaleId: string,
    _hips?: NormalizedHip[],
    opts: { saleName?: string; startDate?: Date | null } = {}
  ): Promise<Map<string, Date>> {
    return (await this.resolveSessionDatesWithSource(externalSaleId, opts)).dates;
  }

  /**
   * Fecha de sesión por Hip. Fuente 1 (la de siempre): el campo "session"
   * de cada Hip en la API del catálogo. Fuente 2 (2026-09-29, Ramon: "el
   * calendario de Fasig-Tipton October no se descargó"): con el catálogo
   * recién publicado, Fasig-Tipton deja "session" en null para TODOS los
   * Hips (Kentucky October Yearlings/320: 1612 de 1612) y lo completa
   * recién cerca de la venta — pero el calendario oficial ya está publicado
   * en la página de la venta ("10/19: Hips 1-404 · 10/20: Hips 405-808 ·
   * …"). Solo si la fuente 1 viene vacía se lee esa página oficial. Nada se
   * deduce: un Hip fuera de los rangos publicados queda sin fecha.
   */
  private async resolveSessionDatesWithSource(
    externalSaleId: string,
    opts: { saleName?: string; startDate?: Date | null }
  ): Promise<{ dates: Map<string, Date>; source: string }> {
    const entries = await this.fetchRaw(externalSaleId);
    const result = new Map<string, Date>();
    for (const entry of entries) {
      if (!entry.session) continue;
      const date = new Date(`${entry.session}T12:00:00-04:00`); // mediodía ET para evitar corrimientos de día por huso horario
      if (!isNaN(date.getTime())) {
        result.set(String(entry.hip), date);
      }
    }
    if (result.size > 0 || !opts.saleName || !opts.startDate) {
      return { dates: result, source: "FASIG_TIPTON_CATALOG_SESSION_FIELD" };
    }

    const schedule = await this.fetchOfficialSchedule(opts.saleName, opts.startDate);
    for (const entry of entries) {
      const hipNumber = Number(entry.hip);
      if (!Number.isInteger(hipNumber)) continue;
      const day = schedule.find((d) => hipNumber >= d.hipStart && hipNumber <= d.hipEnd);
      if (day) result.set(String(entry.hip), day.date);
    }
    return { dates: result, source: "FASIG_TIPTON_OFFICIAL_SALE_PAGE_SCHEDULE" };
  }

  private scheduleCache = new Map<string, { days: { date: Date; hipStart: number; hipEnd: number }[]; fetchedAt: number }>();

  // Página oficial de la venta: https://www.fasigtipton.com/{año}/{Nombre-De-La-Venta}
  // (ej. /2026/Kentucky-October-Yearlings). Cualquier fallo (404, red,
  // página sin calendario todavía) devuelve [] — el calendario queda en
  // espera como antes, nunca rompe la sincronización del catálogo.
  private async fetchOfficialSchedule(saleName: string, startDate: Date): Promise<{ date: Date; hipStart: number; hipEnd: number }[]> {
    const year = startDate.getUTCFullYear();
    const slug = saleName.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const url = `https://www.fasigtipton.com/${year}/${slug}`;
    const cached = this.scheduleCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.days;

    let days: { date: Date; hipStart: number; hipEnd: number }[] = [];
    try {
      const response = await fetchWithRetry(url, { headers: { Accept: "text/html" } });
      if (!response.ok) {
        console.log(`[sale-days] Fasig-Tipton "${saleName}": página oficial ${url} respondió ${response.status}.`);
        return [];
      }
      const text = (await response.text()).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
      const pattern = /(\d{1,2})\/(\d{1,2})\s*:\s*Hips?\s*#?\s*(\d+)\s*(?:-|–|—|to)\s*(\d+)/gi;
      const seen = new Set<string>();
      const minTime = startDate.getTime() - 2 * 24 * 60 * 60 * 1000;
      const maxTime = startDate.getTime() + 21 * 24 * 60 * 60 * 1000;
      for (const m of text.matchAll(pattern)) {
        const [month, dayOfMonth, hipStart, hipEnd] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        const date = new Date(`${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}T12:00:00-04:00`);
        if (isNaN(date.getTime()) || date.getTime() < minTime || date.getTime() > maxTime || hipEnd < hipStart) continue;
        const key = `${date.toISOString()}|${hipStart}|${hipEnd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        days.push({ date, hipStart, hipEnd });
      }
      console.log(`[sale-days] Fasig-Tipton "${saleName}": ${days.length} jornada(s) en la página oficial ${url}.`);
    } catch (err) {
      console.log(`[sale-days] Fasig-Tipton "${saleName}": no se pudo leer la página oficial ${url}: ${String(err)}`);
      days = [];
    }
    this.scheduleCache.set(url, { days, fetchedAt: Date.now() });
    return days;
  }

  // Calendario de Ventas para Fasig-Tipton (implementado 2026-08-15, a
  // pedido: "utilizando exactamente el mismo funcionamiento, diseño y
  // ubicación que ya está implementado para Keeneland"). Fuente: la fecha
  // de sesión por Hip (ver resolveSessionDatesWithSource arriba — campo
  // "session" del catálogo, o el calendario oficial de la página de la
  // venta mientras ese campo siga vacío).
  async resolveSaleDays(
    externalSaleId: string,
    opts: { scheduleYear?: number | null; scheduleSlug?: string | null; saleName?: string; startDate?: Date | null }
  ): Promise<ResolvedSaleDay[]> {
    const { dates, source } = await this.resolveSessionDatesWithSource(externalSaleId, opts);
    return resolveSaleDaysFromSessionDates(dates, source);
  }
}
