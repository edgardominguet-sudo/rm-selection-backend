import { DiscoveredSaleAnnouncement, SaleDiscoveryClient } from "./types";
import { findDateRange, stripHtmlTags } from "./dateParsing";

// OBS (Ocala Breeders' Sales) no tiene ninguna API de catálogo estructurada
// conocida — a diferencia de Fasig-Tipton y Keeneland, su plataforma de
// pujas (bid.obssales.com / obsonline.com) es un sistema aparte del que no
// hay documentación pública de acceso programático. Se investigó a fondo
// el 2026-08-05: el catálogo real de cada venta vive en obscatalog.com
// (URLs del tipo /{mes}preview/{año}/, ej. /marpreview/2024/), con una
// tabla que trae exactamente los campos que hacen falta (Hip #, Walking
// Video, UT Video, Photo, Foaling Date, Color, Sex, Name, Sire, Dam, Dam
// Sire, Consignor, Barn) — pero esa tabla se llena 100% del lado del
// cliente vía JavaScript/AJAX; el HTML que devuelve el servidor no trae
// ningún dato, y no se identificó ningún endpoint JSON/XML público
// detrás. No hay forma automática y respetuosa de leerlo hoy.
//
// Por eso este cliente de descubrimiento SOLO detecta el ANUNCIO de una
// venta nueva (nombre, fechas) — el catálogo en sí se carga a mano vía
// POST /sales/:saleId/catalog/import con el CSV/export que el propio OBS
// ya distribuye a consignatarios y compradores (ver
// saleHouses/manualCatalogImport.ts): toda venta que este cliente
// encuentra queda con catalogAccess MANUAL_CSV, NO con un callejón sin
// salida permanente — una vez cargado el CSV, el resto del pipeline
// (análisis, ranking, historial de ventas) funciona exactamente igual que
// para Keeneland o Fasig-Tipton. Si en el futuro OBS publica una API real,
// src/saleHouses/obs.ts (hoy un stub) se completa y la venta puede pasar a
// FULL sin perder nada de lo ya importado a mano.
//
// Fuente elegida: el feed RSS estándar de WordPress (obssales.com/feed/),
// en vez de scrapear el HTML del calendario. Es la opción más respetuosa
// de las disponibles: un feed RSS es, por diseño, un mecanismo pensado para
// consumo automático — no hace falta interpretar un calendario visual
// renderizado por JavaScript, y no está deshabilitado en robots.txt (que
// solo restringe /wp-admin/).
const FEED_URL = "https://obssales.com/feed/";

// Palabras que indican que un post del blog es un anuncio de venta o
// catálogo (no una nota de resultados de carrera de un graduado, que es la
// mayoría del contenido de ese blog). Heurística best-effort — puede haber
// falsos negativos (un anuncio con título atípico que no matchea), nunca
// falsos positivos graves porque igual se exige una fecha futura parseable
// antes de crear la venta.
const ANNOUNCEMENT_KEYWORDS = /\b(sale|catalogue|catalog)\b/i;
const YEAR_IN_TITLE = /\b(20\d{2})\b/;

export class OBSDiscoveryClient implements SaleDiscoveryClient {
  async discoverAnnouncedSales(_now: Date): Promise<DiscoveredSaleAnnouncement[]> {
    let xml: string;
    try {
      const response = await fetch(FEED_URL, { headers: { Accept: "application/rss+xml, text/xml" } });
      if (!response.ok) return [];
      xml = await response.text();
    } catch {
      return [];
    }

    const results: DiscoveredSaleAnnouncement[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let itemMatch: RegExpExecArray | null;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const itemXml = itemMatch[1];
      const title = extractTag(itemXml, "title");
      const link = extractTag(itemXml, "link");
      if (!title || !link) continue;
      if (!ANNOUNCEMENT_KEYWORDS.test(title) || !YEAR_IN_TITLE.test(title)) continue;

      // La fecha de la VENTA (no la fecha de publicación del post) tiene
      // que estar en el título o en la descripción — si no aparece de
      // forma parseable, se descarta en vez de usar la fecha de
      // publicación del blog como aproximación (podría estar publicado
      // meses antes de la venta, o ser un post posterior sobre resultados).
      const description = extractTag(itemXml, "description") ?? "";
      const range = findDateRange(stripHtmlTags(title)) ?? findDateRange(stripHtmlTags(description));
      if (!range) continue;
      const startDate = range.start;

      results.push({
        name: title.trim(),
        // Sintético: OBS no tiene ningún ID de catálogo real todavía —
        // igual sirve para identificar la venta de forma estable en
        // Sale.externalSaleId (el import manual la referencia por
        // Sale.id, no por este string).
        externalSaleId: `obs-${slugify(title)}`,
        startDate,
        endDate: range.end,
        announcementUrl: link.trim(),
        access: "MANUAL_CSV",
      });
    }

    return results;
  }
}

function extractTag(xml: string, tag: string): string | null {
  const cdataMatch = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(xml);
  if (cdataMatch) return cdataMatch[1];
  const plainMatch = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return plainMatch ? plainMatch[1] : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
