import { DiscoveredSaleAnnouncement, SaleDiscoveryClient } from "./types";
import { findFirstDateRange, stripHtmlTags } from "./dateParsing";

// OBS (Ocala Breeders' Sales) no tiene ninguna API de catálogo estructurada
// conocida — a diferencia de Fasig-Tipton y Keeneland, su plataforma de
// pujas (bid.obssales.com / obsonline.com) es un sistema aparte del que no
// hay documentación pública de acceso programático. Por eso este cliente
// SOLO puede detectar el ANUNCIO de una venta nueva, nunca su catálogo —
// toda venta que encuentra queda con catalogAccess UNAVAILABLE
// permanentemente, hasta que OBS publique un método de acceso autorizado
// (API pública, licencia de datos, etc.) y se construya un SaleHouseClient
// real para esa casa (hoy src/saleHouses/obs.ts es un stub que tira error
// a propósito en vez de inventar datos).
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
      const startDate = findFirstDateRange(stripHtmlTags(title)) ?? findFirstDateRange(stripHtmlTags(description));
      if (!startDate) continue;

      results.push({
        name: title.trim(),
        // Sintético: OBS no tiene ningún ID de catálogo real todavía.
        externalSaleId: `obs-${slugify(title)}`,
        startDate,
        announcementUrl: link.trim(),
        access: "UNAVAILABLE",
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
