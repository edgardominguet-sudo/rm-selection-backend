// Obtiene automáticamente, desde el programa oficial de la venta que
// publica Keeneland en su página pública "Sales / Deadlines and Schedule"
// (ej. https://www.keeneland.com/sales/2025/2/september-yearling-sale/about/),
// una tabla de correspondencia entre rangos de Hip Number y la fecha
// calendario de cada sesión — sin que el usuario tenga que cargar ningún
// rango a mano. Puerto directo de
// RMSelection/Services/KeenelandScheduleOfSaleService.swift.
//
// FRAGILIDAD CONOCIDA Y ACEPTADA (igual que en la versión iOS): esta es
// una página HTML pública pensada para lectura humana, no un endpoint
// estable. Si Keeneland cambia el texto de forma importante, el parseo se
// degrada devolviendo un mapa vacío — nunca inventa una fecha.

export interface ScheduledSession {
  number: number;
  date: Date;
  hipRanges: [number, number][];
}

export async function fetchKeenelandSchedule(year: number, saleId: string, slug: string): Promise<ScheduledSession[]> {
  const url = `https://www.keeneland.com/sales/${year}/${saleId}/${slug}/about/`;
  let html: string;
  try {
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok) return [];
    html = await response.text();
  } catch {
    return [];
  }
  return parseSchedule(html, year);
}

export async function resolveKeenelandHipDates(year: number, saleId: string, slug: string): Promise<Map<string, Date>> {
  const sessions = await fetchKeenelandSchedule(year, saleId, slug);
  const result = new Map<string, Date>();
  for (const session of sessions) {
    for (const [low, high] of session.hipRanges) {
      for (let hip = low; hip <= high; hip++) {
        result.set(String(hip), session.date);
      }
    }
  }
  return result;
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export function parseSchedule(html: string, year: number): ScheduledSession[] {
  const plainText = html.replace(/<[^>]+>/g, "\n");
  const decoded = plainText
    .replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&#8217;/g, "'");

  const sessionRegex = /Session\s+(\d+)\s*:?\s*[A-Za-z]+,\s*([A-Za-z]+)\s+(\d{1,2})/g;
  const hipRangeRegex = /(?:Main Catalog|Supplemental)\s*HIPS?:?\s*(\d+)\s*-\s*(\d+)/g;

  const sessionMatches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = sessionRegex.exec(decoded)) !== null) {
    sessionMatches.push(match);
  }

  const sessions: ScheduledSession[] = [];

  for (let i = 0; i < sessionMatches.length; i++) {
    const m = sessionMatches[i];
    const sessionNumber = parseInt(m[1], 10);
    const monthName = m[2].toLowerCase();
    const day = parseInt(m[3], 10);
    const monthIndex = MONTHS[monthName];
    if (monthIndex === undefined || isNaN(sessionNumber) || isNaN(day)) continue;

    // Mediodía hora del este de EE.UU. (evita corrimientos de día por
    // huso horario al comparar fechas más adelante).
    const date = new Date(Date.UTC(year, monthIndex, day, 16, 0, 0)); // ~12:00 ET

    const blockStart = m.index;
    const blockEnd = i + 1 < sessionMatches.length ? sessionMatches[i + 1].index : decoded.length;
    if (blockEnd <= blockStart) continue;
    const blockText = decoded.slice(blockStart, blockEnd);

    const ranges: [number, number][] = [];
    let rangeMatch: RegExpExecArray | null;
    const localHipRangeRegex = new RegExp(hipRangeRegex.source, "g");
    while ((rangeMatch = localHipRangeRegex.exec(blockText)) !== null) {
      const low = parseInt(rangeMatch[1], 10);
      const high = parseInt(rangeMatch[2], 10);
      if (!isNaN(low) && !isNaN(high) && low <= high) {
        ranges.push([low, high]);
      }
    }
    if (ranges.length === 0) continue;

    sessions.push({ number: sessionNumber, date, hipRanges: ranges });
  }

  return sessions;
}
