import { DiscoveredSaleAnnouncement, SaleDiscoveryClient } from "./types";
import { findFirstDateRange, stripHtmlTags, titleCaseSlug } from "./dateParsing";

// Lee la página pública "Catalogues" de Fasig-Tipton por año — a diferencia
// de Keeneland, esta página lista TODAS las ventas del año (pasadas y
// futuras mezcladas), así que el filtro de "solo futuras" es
// responsabilidad de saleDiscoveryService (acá solo se extrae fecha+nombre
// para que ese filtro sea posible).
//
// LIMITACIÓN CONOCIDA: el ID numérico interno que pide la API de catálogo
// (`django/api/horses/?sale={id}`) NO aparece en esta página pública ni en
// la página de detalle de cada venta (se confirmó: la pestaña "Catalogue"
// carga su contenido vía JavaScript del lado del cliente, y ese ID no está
// embebido en el HTML que devuelve el servidor). Adivinar el ID por fuerza
// bruta (probar números secuenciales) NO es un método de acceso autorizado
// y podría exponer catálogos de ventas ajenas a esta cuenta — por eso no se
// implementa. En su lugar, estas ventas quedan con catalogAccess
// PENDING_ID: se detectan, se alertan y se crean en la base, pero el
// scheduler no las sincroniza hasta que alguien cargue el ID real (se
// consigue una vez, a mano, inspeccionando la pestaña "Bid Online" /
// Client Portal) vía POST /sales.
//
// Permitido por robots.txt de fasigtipton.com (no está bajo /admin/,
// /search/ ni ninguna otra ruta prohibida).
const CATALOGUES_URL = (year: number) => `https://www.fasigtipton.com/catalogues/${year}`;

// href="https://www.fasigtipton.com/2026/The-Saratoga-Sale" (o relativo)
const LINK_REGEX = /href="(?:https:\/\/www\.fasigtipton\.com)?\/(\d{4})\/([A-Za-z0-9-]+)"[^>]*>([^<]*)<\/a>/g;

export class FasigTiptonDiscoveryClient implements SaleDiscoveryClient {
  async discoverAnnouncedSales(now: Date): Promise<DiscoveredSaleAnnouncement[]> {
    // Cubre el cambio de año: en noviembre/diciembre, Fasig-Tipton ya
    // suele tener publicado (al menos parcialmente) el catálogo del año
    // siguiente — sin esto, una venta anunciada a fin de año no se vería
    // hasta que cambie el reloj.
    const years = [now.getUTCFullYear(), now.getUTCFullYear() + 1];
    const results: DiscoveredSaleAnnouncement[] = [];
    const seen = new Set<string>();

    for (const year of years) {
      let html: string;
      try {
        const response = await fetch(CATALOGUES_URL(year), { headers: { Accept: "text/html" } });
        if (!response.ok) continue;
        html = await response.text();
      } catch {
        continue;
      }

      let match: RegExpExecArray | null;
      const regex = new RegExp(LINK_REGEX.source, "g");
      while ((match = regex.exec(html)) !== null) {
        const [, linkYear, slug, linkText] = match;
        // La página de catálogos también linkea a los años del archivo
        // ("2026", "2025", ...) con ese mismo patrón /{year}/{slug} — un
        // slug puramente numérico de 4 dígitos es justamente eso, no una
        // venta, así que se descarta.
        if (/^\d{4}$/.test(slug)) continue;

        const key = `${linkYear}/${slug}`;
        if (seen.has(key)) continue;

        // El nombre real de la venta está en el encabezado "### [Nombre](...)"
        // que sigue a la miniatura — buscamos el bloque de texto alrededor
        // de esta aparición del link para sacar nombre + fecha juntos,
        // porque el primer <a> de cada tarjeta (la imagen) no trae texto.
        const windowStart = match.index;
        const windowEnd = Math.min(html.length, windowStart + 1200);
        const windowText = stripHtmlTags(html.slice(windowStart, windowEnd));
        const startDate = findFirstDateRange(windowText);
        if (!startDate) continue; // no se pudo leer una fecha confiable — se descarta, no se inventa.

        const cleanLinkText = linkText.trim();
        const name = cleanLinkText.length > 0 && cleanLinkText.length < 80 ? cleanLinkText : titleCaseSlug(slug);

        seen.add(key);
        results.push({
          name,
          // Sintético: no hay ID real de catálogo disponible públicamente
          // — ver comentario arriba.
          externalSaleId: `${linkYear}-${slug}`,
          startDate,
          announcementUrl: `https://www.fasigtipton.com/${linkYear}/${slug}`,
          access: "PENDING_ID",
        });
      }
    }

    return results;
  }
}
