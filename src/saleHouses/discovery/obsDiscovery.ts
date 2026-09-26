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
      let range = findDateRange(stripHtmlTags(title)) ?? findDateRange(stripHtmlTags(description));

      if (!range) {
        // ULTIMO RECURSO (2026-09-26, causa raiz real de "OBS October no
        // aparece" -- parte 2, descubierta al correr la prueba manual
        // controlada de discovery): el <description> que entrega el feed
        // RSS de WordPress viene TRUNCADO por WordPress mismo justo antes
        // de que aparezca el rango de dias real (ej. el texto real termina
        // en "...The two-day sale is set for Tuesday and Wednesday,&#8230;"
        // -- corta ahi, nunca llegan los numeros "Oct. 6-7"). Ni el titulo
        // ni la descripcion del feed traen la fecha completa para este
        // formato de anuncio. Como ultimo recurso, se trae la pagina
        // publica completa del anuncio (el mismo <link> del item -- HTML
        // estatico servido por el propio WordPress, sin necesitar
        // JavaScript, verificado) y se busca la fecha DENTRO del cuerpo
        // real del articulo (contenedor "entry-content", acotado hasta el
        // primer marcador de cierre conocido o un tope de seguridad) --
        // nunca en la pagina entera, porque el HTML completo trae antes
        // del cuerpo la fecha de PUBLICACION del post (verificado: aparece
        // antes de "entry-content" en el HTML) que un scan sin acotar
        // agarraria por error en vez de la fecha real de la venta. Se
        // acepta esta unica llamada extra por anuncio -- el descubrimiento
        // corre con poca frecuencia (ver saleDiscoveryService.ts) y solo
        // llega hasta aca cuando titulo+descripcion no alcanzaron.
        range = await findDateRangeFromAnnouncementPage(link.trim());
      }

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

/**
 * Ultimo recurso cuando ni el titulo ni la descripcion del feed RSS traen
 * una fecha parseable (ver comentario mas arriba, 2026-09-26): trae la
 * pagina publica del anuncio y busca la fecha dentro del cuerpo real del
 * articulo, nunca en la pagina entera. Mismo criterio de "nunca inventar
 * una fecha" que el resto del archivo: cualquier fallo (red, marcador de
 * contenido no encontrado, sin match) devuelve null y el llamador descarta
 * el anuncio, nunca aproxima con la fecha de publicacion del post.
 */
async function findDateRangeFromAnnouncementPage(url: string): Promise<{ start: Date; end: Date } | null> {
  let html: string;
  try {
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  // "entry-content" es el contenedor estandar de WordPress para el cuerpo
  // real de un post (verificado en el HTML real de obssales.com, incluye
  // itemprop="mainEntityOfPage") -- todo lo que viene ANTES (header, menu,
  // metadata del post incluida su fecha de PUBLICACION) queda afuera del
  // rango buscado a proposito.
  const startIdx = html.indexOf("entry-content");
  if (startIdx < 0) return null;

  // Cortar en el primer marcador de "fin del cuerpo del post" que aparezca
  // (tags de WordPress, compartir en redes, comentarios, posts
  // relacionados) para no arrastrar fechas de contenido no relacionado que
  // venga despues en la misma pagina. Si el tema no trae ninguno de estos
  // marcadores, un tope de longitud fijo cumple la misma funcion de forma
  // segura -- nunca se escanea la pagina completa.
  const endMarkers = ["entry-footer", "post-tags", "sharedaddy", "comments-area", "jp-relatedposts", "related-posts"];
  const MAX_BODY_LENGTH = 8000;
  let endIdx = Math.min(html.length, startIdx + MAX_BODY_LENGTH);
  for (const marker of endMarkers) {
    const idx = html.indexOf(marker, startIdx);
    if (idx > startIdx && idx < endIdx) endIdx = idx;
  }

  const body = stripHtmlTags(html.slice(startIdx, endIdx));
  return findDateRange(body);
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
