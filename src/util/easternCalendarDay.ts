/**
 * Utilidades de "día calendario" en el huso horario donde operan las casas
 * de venta que integramos (Keeneland, Fasig-Tipton, OBS): todas en EE.UU.,
 * huso America/New_York (Eastern).
 *
 * BUG CORREGIDO 2026-09-15 (a raíz del reporte "no se ven los precios" —
 * el Ranking del Día de hoy se borró solo y el precio en vivo se
 * desactivó ~4-5h antes de lo debido, mientras la jornada real en Kentucky
 * seguía en curso): rankingService.ts, api/routes.ts y pollingPolicy.ts
 * calculaban "día calendario" con los componentes UTC del Date
 * (getUTCFullYear/Month/Date + Date.UTC(...)) en vez del huso real de la
 * venta. sessionDate se guarda anclado a mediodía ET (ver
 * saleHouses/keeneland.ts, keenelandSchedule.ts, fasigTipton.ts,
 * manualCatalogImport.ts — deliberado, para que la FECHA nunca se corra) —
 * pero la MEDIANOCHE de esa fecha, calculada en UTC, cae ~4-5h antes de la
 * medianoche ET real (EDT = UTC-4, EST = UTC-5). Eso corría para atrás
 * tanto el inicio como el fin de toda ventana de "jornada en curso":
 * Ranking del Día en vivo, precio en vivo cada 10 min
 * (syncLivePricesForActiveSessions), borrado automático 2h post-venta
 * (cleanupExpiredRankingSnapshots) y GET /ranking?date=. Esta versión usa
 * Intl con timeZone America/New_York para que la medianoche sea la real,
 * sea EDT o EST, sin depender de un offset fijo.
 */

const SALE_HOUSE_TIME_ZONE = "America/New_York";

/** Offset de America/New_York respecto a UTC, en minutos, en el instante dado (negativo = detrás de UTC; p.ej. -240 en EDT, -300 en EST). */
function easternOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SALE_HOUSE_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asIfUtc - instant.getTime()) / 60_000;
}

/** Componentes de fecha (año/mes/día) de `instant`, tal como se leen en el huso de la venta (America/New_York). */
function easternDateParts(instant: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SALE_HOUSE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * Instante UTC de la medianoche 00:00 America/New_York del día calendario
 * (huso ET) al que pertenece `date`. Reemplaza al viejo
 * `Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())`
 * — ver comentario de archivo.
 */
export function startOfCalendarDay(date: Date): Date {
  const { year, month, day } = easternDateParts(date);
  const utcGuess = Date.UTC(year, month - 1, day);
  const offsetMinutes = easternOffsetMinutes(new Date(utcGuess));
  return new Date(utcGuess - offsetMinutes * 60_000);
}

/** true si `a` y `b` caen en el mismo día calendario en el huso ET (mismo criterio que usa el resto de la app para "jornada en curso"). */
export function isSameEasternCalendarDay(a: Date, b: Date): boolean {
  const pa = easternDateParts(a);
  const pb = easternDateParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}
