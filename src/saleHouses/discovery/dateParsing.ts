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
  return findDateRange(plainText)?.start ?? null;
}

/**
 * Igual que `findFirstDateRange`, pero además devuelve el ÚLTIMO día del
 * rango (ej. "Sept. 14 - 26, 2026" -> start=14, end=26; "Aug 16, 2026" ->
 * start=end=16, venta de un solo día) — usado para completar
 * `Sale.endDate` en el mismo momento en que se detecta el anuncio (ver
 * saleDiscoveryService.ts), sin la cual la app no podría mostrar "Día X de
 * Y" para ninguna venta que el servidor descubra sola. Mismo criterio de
 * "nunca inventar": si no hay rango legible, devuelve null.
 */
function buildDateRange(monthStr: string, startDayStr: string, endDayStr: string | undefined, yearStr: string): { start: Date; end: Date } | null {
  const monthIndex = MONTHS[monthStr.toLowerCase()];
  const startDay = parseInt(startDayStr, 10);
  const endDay = endDayStr ? parseInt(endDayStr, 10) : startDay;
  const year = parseInt(yearStr, 10);
  if (monthIndex === undefined || isNaN(startDay) || isNaN(year)) return null;
  // Mediodía hora del este de EE.UU. (evita corrimientos de día por huso
  // horario) — mismo criterio que el resto del backend.
  const start = new Date(Date.UTC(year, monthIndex, startDay, 16, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex, isNaN(endDay) ? startDay : endDay, 16, 0, 0));
  return { start, end };
}

/**
 * Año de 4 dígitos (20xx) más CERCANO (antes o después, el que quede a
 * menos caracteres de distancia) a la posición de un fragmento "Mes
 * Día[-Día]" ya encontrado en el mismo texto — usado por el camino de
 * respaldo de abajo. Nunca inventa el año: si no hay ningún 20xx en todo
 * el texto, no hay nada que emparejar.
 */
function nearestYear(text: string, matchIndex: number, matchLength: number): number | null {
  const yearRegex = /\b(20\d{2})\b/g;
  let best: { year: number; distance: number } | null = null;
  let yearMatch: RegExpExecArray | null;
  while ((yearMatch = yearRegex.exec(text)) !== null) {
    const yearPos = yearMatch.index;
    const distance =
      yearPos < matchIndex ? matchIndex - (yearPos + yearMatch[0].length) : yearPos - (matchIndex + matchLength);
    if (!best || distance < best.distance) {
      best = { year: parseInt(yearMatch[1], 10), distance };
    }
  }
  return best ? best.year : null;
}

export function findDateRange(plainText: string): { start: Date; end: Date } | null {
  // Camino principal: "Mes Día[-Día], Año" contiguo (ej. "Sept. 14 - 26,
  // 2026") — el más confiable, sin ambigüedad de a qué año pertenece la
  // fecha. Se prueba primero SIEMPRE; el camino de respaldo de abajo nunca
  // cambia un resultado que este ya resuelve.
  const strict = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?,?\s+(\d{4})/;
  const strictMatch = strict.exec(plainText);
  if (strictMatch) {
    return buildDateRange(strictMatch[1], strictMatch[2], strictMatch[3], strictMatch[4]);
  }

  // Camino de respaldo (2026-09-26, causa raíz real de "OBS October no
  // aparece"): el anuncio de OBS trae el rango de días SIN el año pegado
  // ("...2026 October Yearling Sale... two-day sale is set for Tuesday and
  // Wednesday, Oct. 6-7. Supplemental entries...") — el año queda en otra
  // oración del mismo texto, no inmediatamente después del rango de días,
  // así que el patrón estricto de arriba nunca matchea y el anuncio se
  // descartaba en silencio (nunca daba error, simplemente `found: 0` para
  // OBS todos los días). Acorde con el criterio de "nunca inventar una
  // fecha" (ver comentario de archivo): busca "Mes Día[-Día]" SIN año
  // pegado, y lo empareja con el año de 4 dígitos (20xx) más CERCANO en
  // ese mismo texto — nunca con "el primero que aparezca" a secas, para no
  // agarrar por error un año de otra oración sin relación (ej. el año de
  // nacimiento de un graduado mencionado en el mismo párrafo). Recorre
  // TODOS los matches de "palabra + número" del texto (no solo el
  // primero) hasta encontrar uno cuya palabra sea realmente un mes válido,
  // para no trabarse con un falso positivo tipo "Company's 27" antes de
  // llegar al mes real.
  const loose = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/g;
  let looseMatch: RegExpExecArray | null;
  while ((looseMatch = loose.exec(plainText)) !== null) {
    if (MONTHS[looseMatch[1].toLowerCase()] === undefined) continue;
    const year = nearestYear(plainText, looseMatch.index, looseMatch[0].length);
    if (year === null) continue;
    const range = buildDateRange(looseMatch[1], looseMatch[2], looseMatch[3], String(year));
    if (range) return range;
  }
  return null;
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
