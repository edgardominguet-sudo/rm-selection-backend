// Utilidades de parseo de fecha compartidas por los tres scrapers de
// descubrimiento — mismo criterio que keenelandSchedule.ts: nunca se
// inventa o "adivina" una fecha; si el texto no matchea, se devuelve null y
// el llamador descarta ese anuncio en vez de crear una venta con datos
// incorrectos.

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Busca el primer patrón "Mes Día[-Día], Año" (ej. "Sept. 14 - 26, 2026",
 * "Aug 16 - 17, 2026", "Feb 09, 2026") en un texto plano y devuelve la
 * fecha del PRIMER día — es lo que importa para decidir si la venta ya
 * pasó o todavía es futura.
 */
export function findFirstDateRange(plainText: string): Date | null {
  const regex = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*[-–]\s*\d{1,2})?,?\s+(\d{4})/;
  const match = regex.exec(plainText);
  if (!match) return null;
  const monthIndex = MONTHS[match[1].toLowerCase()];
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  if (monthIndex === undefined || isNaN(day) || isNaN(year)) return null;
  // Mediodía hora del este de EE.UU. (evita corrimientos de día por huso
  // horario) — mismo criterio que el resto del backend.
  return new Date(Date.UTC(year, monthIndex, day, 16, 0, 0));
}

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** "september-yearling-sale" -> "September Yearling Sale" — nombre de respaldo cuando no se puede leer un título legible. */
export function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
