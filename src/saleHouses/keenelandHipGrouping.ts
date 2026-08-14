import { ResolvedSaleDay } from "../types";

// Fuente del Calendario de Ventas (SaleDay) para Keeneland: el "Hip
// Summary" (nombre interno del archivo: "Hip Grouping") — un PDF oficial
// que Keeneland publica por venta con la tabla completa Book / Session /
// Date / Start Time / Hip # (rango) / # Head. A diferencia de
// keenelandSchedule.ts (que scrapea la página "about" y solo resuelve
// fecha por Hip, sin Book), este documento trae exactamente lo que pide
// el Calendario de Ventas, en un formato tabular estable pensado para
// consignatarios/compradores — no una página de marketing.
//
// DESCUBRIMIENTO 100% AUTOMÁTICO: no se hardcodea ningún nombre de archivo
// ni código de venta. Se lee la página pública "Resources" de la venta
// (la misma que usaría un humano para bajar el PDF) y se toma el href
// real detrás del link "Hip Summary" — si Keeneland cambia la convención
// de nombre de un año a otro, esto se sigue resolviendo solo. Nunca se
// inventa una URL: si no se encuentra el link, se devuelve null y el
// calendario de esa venta simplemente queda vacío (no es un error).

export async function resolveKeenelandHipGroupingUrl(year: number, saleId: string, slug: string): Promise<string | null> {
  const url = `https://www.keeneland.com/sales/${year}/${saleId}/${slug}/resources/`;
  let html: string;
  try {
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok) {
      console.error(`[keeneland-hip-grouping] Página de Resources no disponible (status ${response.status}): ${url}`);
      return null;
    }
    html = await response.text();
  } catch (err) {
    console.error(`[keeneland-hip-grouping] Error de red pidiendo la página de Resources (${url}):`, err);
    return null;
  }
  const href = extractHipSummaryHref(html);
  if (!href) {
    console.error(`[keeneland-hip-grouping] No se encontró el link "Hip Summary" en ${url} (posible cambio de estructura de la página).`);
  }
  return href;
}

export function extractHipSummaryHref(html: string): string | null {
  // Primero, el link real por su texto visible ("Hip Summary") — más
  // robusto a cambios de nombre de archivo.
  const byLabel = /<a\s+[^>]*href="([^"]+)"[^>]*>\s*Hip Summary\s*<\/a>/i.exec(html);
  const href = byLabel?.[1]
    // Respaldo: si la estructura del link cambia pero el archivo se sigue
    // llamando "HipGrouping...pdf" (confirmado en vivo 2026-08-14), lo
    // encontramos igual sin depender del texto del link.
    ?? /href="([^"]*HipGrouping[^"]*\.pdf)"/i.exec(html)?.[1]
    ?? null;
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return `https://www.keeneland.com${href.startsWith("/") ? "" : "/"}${href}`;
}

export async function fetchAndParseKeenelandHipGrouping(pdfUrl: string): Promise<ResolvedSaleDay[]> {
  let buffer: Buffer;
  try {
    const response = await fetch(pdfUrl, { headers: { Accept: "application/pdf" } });
    if (!response.ok) {
      console.error(`[keeneland-hip-grouping] PDF no disponible (status ${response.status}): ${pdfUrl}`);
      return [];
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error(`[keeneland-hip-grouping] Error de red pidiendo el PDF (${pdfUrl}):`, err);
    return [];
  }
  if (buffer.length === 0) {
    console.error(`[keeneland-hip-grouping] PDF vacío (0 bytes): ${pdfUrl}`);
    return [];
  }
  try {
    // Import perezoso (mismo criterio que keenelandPedigreePdfCatalog.ts):
    // pdf-parse carga pdf.js, trabajo pesado que solo vale la pena pagar
    // cuando de verdad hace falta.
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    const days = parseHipGroupingText(parsed.text);
    if (days.length === 0) {
      console.error(`[keeneland-hip-grouping] El PDF se leyó (${parsed.text.length} caracteres) pero el parser no encontró ninguna jornada — posible cambio de formato. Primeros 300 caracteres: ${JSON.stringify(parsed.text.slice(0, 300))}`);
    }
    return days;
  } catch (err) {
    console.error(`[keeneland-hip-grouping] No se pudo leer el PDF (${pdfUrl}):`, err);
    return [];
  }
}

/** Resuelve, en un solo paso, el calendario completo de una venta de Keeneland — o [] si todavía no hay forma de resolverlo. */
export async function resolveKeenelandSaleDays(year: number, saleId: string, slug: string): Promise<ResolvedSaleDay[]> {
  const pdfUrl = await resolveKeenelandHipGroupingUrl(year, saleId, slug);
  if (!pdfUrl) return [];
  return fetchAndParseKeenelandHipGrouping(pdfUrl);
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Línea de solo el número/código de Book (celda combinada en el PDF
// original: aparece una sola vez arriba de las sesiones que le
// pertenecen) — ej. "1", "2", "5A", "5B". Nunca 4 dígitos (para no
// confundirse con la línea del año de la venta).
const BOOK_LINE = /^(\d{1,2}[A-Za-z]?)$/;

// Línea de una sesión real: "3 Wednesday, September 16 11:00 am 381 – 757 377"
// => sessionNumber, weekday(ignorado), month, day, startTime, hipStart, hipEnd, headCount.
const SESSION_LINE = /^(\d{1,2})\s+[A-Za-z]+day,?\s+([A-Za-z]+)\s+(\d{1,2})\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)\s+(\d+)\s*[–-]\s*(\d+)\s+(\d+)\s*$/i;

// "2026 SEPTEMBER YEARLING SALE" — de acá sale el año real de la venta
// (más confiable que asumir el `year` que llegó por parámetro, que es
// solo el año de la URL/anuncio).
const YEAR_LINE = /^(\d{4})\s+[A-Z]/;

export function parseHipGroupingText(rawText: string): ResolvedSaleDay[] {
  const lines = rawText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  let year: number | null = null;
  let currentBook: string | undefined;
  const days: ResolvedSaleDay[] = [];

  for (const line of lines) {
    const yearMatch = YEAR_LINE.exec(line);
    if (yearMatch && year === null) {
      year = parseInt(yearMatch[1], 10);
      continue;
    }

    const sessionMatch = SESSION_LINE.exec(line);
    if (sessionMatch && year !== null) {
      const [, sessionNumStr, monthName, dayStr, startTime, hipStart, hipEnd, headCountStr] = sessionMatch;
      const monthIndex = MONTHS[monthName.toLowerCase()];
      const day = parseInt(dayStr, 10);
      if (monthIndex === undefined || isNaN(day)) continue; // nunca se inventa una fecha
      // Mediodía hora del este de EE.UU. (evita corrimientos de día por huso horario) — mismo criterio que el resto del backend.
      const date = new Date(Date.UTC(year, monthIndex, day, 16, 0, 0));
      const headCount = parseInt(headCountStr, 10);
      days.push({
        date,
        book: currentBook,
        sessionNumber: parseInt(sessionNumStr, 10),
        startTimeLabel: startTime.replace(/\s+/g, " ").trim(),
        hipRangeStart: hipStart,
        hipRangeEnd: hipEnd,
        headCount: isNaN(headCount) ? undefined : headCount,
        source: "KEENELAND_HIP_GROUPING_PDF",
      });
      continue;
    }

    const bookMatch = BOOK_LINE.exec(line);
    if (bookMatch) {
      currentBook = bookMatch[1];
      continue;
    }

    // Cualquier otra línea (encabezados de columna, "DARK DAY", "Total
    // Head – N", "Sale begins with the letter R", etc.) se ignora a
    // propósito — no aporta una jornada de venta real.
  }

  return days;
}
