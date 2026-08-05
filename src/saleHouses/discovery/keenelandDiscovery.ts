import { DiscoveredSaleAnnouncement, SaleDiscoveryClient } from "./types";
import { findFirstDateRange, stripHtmlTags, titleCaseSlug } from "./dateParsing";

// Lee la página pública "Upcoming Sales" de Keeneland — a diferencia de
// Fasig-Tipton y OBS, esta página YA lista solo ventas futuras (no hay que
// filtrar un archivo histórico) y sus URLs traen los tres datos que hacen
// falta para dar de alta la venta automáticamente y con acceso FULL desde
// el día uno: año, ID interno numérico y slug — exactamente lo que
// necesitan tanto la API de catálogo (`district/sale_api/get/catalog/{id}`)
// como el "Schedule of Sale" (keenelandSchedule.ts). No hace falta ningún
// paso de resolución manual, a diferencia de Fasig-Tipton.
//
// Permitido por robots.txt de keeneland.com (no está bajo /admin/, /search/
// ni ninguna de las rutas explícitamente prohibidas).
const UPCOMING_SALES_URL = "https://www.keeneland.com/sales/all-sales/";

// href="https://www.keeneland.com/sales/2026/12/september-yearling-sale/" (o relativo, sin dominio)
const LINK_REGEX = /href="(?:https:\/\/www\.keeneland\.com)?\/sales\/(\d{4})\/(\d+)\/([a-z0-9-]+)\/?"[^>]*>([\s\S]*?)<\/a>/g;

export class KeenelandDiscoveryClient implements SaleDiscoveryClient {
  async discoverAnnouncedSales(_now: Date): Promise<DiscoveredSaleAnnouncement[]> {
    let html: string;
    try {
      const response = await fetch(UPCOMING_SALES_URL, { headers: { Accept: "text/html" } });
      if (!response.ok) return [];
      html = await response.text();
    } catch {
      return [];
    }

    // Cada venta suele aparecer en DOS <a> distintos apuntando a la misma
    // URL (una con la imagen, otra con "Nombre **Fecha**") — nos quedamos
    // con la primera ocurrencia por URL que efectivamente tenga una fecha
    // parseable en su texto, y deduplicamos por (year, id, slug).
    const seen = new Map<string, DiscoveredSaleAnnouncement>();
    let match: RegExpExecArray | null;
    while ((match = LINK_REGEX.exec(html)) !== null) {
      const [, yearStr, id, slug, innerHtml] = match;
      const key = `${yearStr}/${id}/${slug}`;
      if (seen.has(key)) continue;

      const plainText = stripHtmlTags(innerHtml).trim();
      const startDate = findFirstDateRange(plainText);
      if (!startDate) continue; // el otro <a> (solo imagen) no tiene fecha — se descarta, no es error.

      const nameCandidate = plainText.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !/^\d/.test(l));
      const name = nameCandidate && nameCandidate.length < 80 ? nameCandidate : titleCaseSlug(slug);

      seen.set(key, {
        name,
        externalSaleId: id,
        startDate,
        announcementUrl: `https://www.keeneland.com/sales/${yearStr}/${id}/${slug}/`,
        access: "FULL",
        scheduleYear: parseInt(yearStr, 10),
        scheduleSlug: slug,
      });
    }

    // RM Selection evalúa yearlings — Keeneland también organiza ventas de
    // otro tipo en la misma página de "Upcoming Sales" (ej. "January
    // Horses of All Ages Sale", ventas de breeding stock, horses of racing
    // age) que no le sirven de nada a la app pero antes se registraban
    // igual con catalogAccess FULL, así que el scheduler las sincronizaba
    // sin parar aunque nunca fueran a tener un catálogo relevante. Se
    // descartan acá, antes de darlas de alta — así ni siquiera generan una
    // fila en Sale ni una alerta de "Novedades".
    return Array.from(seen.values()).filter((sale) => /yearling/i.test(sale.name));
  }
}
