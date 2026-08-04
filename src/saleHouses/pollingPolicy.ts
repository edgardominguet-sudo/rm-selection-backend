// Política de frecuencia de chequeo del catálogo de una venta, según qué
// tan cerca esté la próxima jornada de subasta. Regla fija pedida por el
// usuario: cuanto más cerca la venta, más seguido se chequea — así no se
// golpea la API de la casa de ventas sin necesidad cuando falta un mes,
// pero se detecta un video/foto nueva casi en tiempo real el día de la
// subasta.
//
// Los cortes de "30-15 / 15-7 / 7d-24h / últimas 24h / jornada en curso"
// son los que pidió el usuario tal cual. Fuera de ese rango (más de 30
// días antes, o ya no queda ninguna sesión futura) se usa un intervalo de
// respaldo razonable, documentado abajo — no fue parte del pedido
// original, pero hace falta algún valor para esos casos.

export const POLLING_TIERS_MINUTES = {
  moreThan30Days: 24 * 60, // respaldo: no especificado por el usuario, 1 vez por día alcanza con un mes de anticipación.
  between30And15Days: 12 * 60,
  between15And7Days: 6 * 60,
  between7DaysAnd24Hours: 60,
  lastDayBeforeSession: 15,
  sessionDayActive: 5,
};

/**
 * Calcula cada cuántos minutos hay que volver a chequear el catálogo de
 * una venta, dado el momento actual y la fecha de su PRÓXIMA jornada sin
 * terminar (sessionDate = día calendario de esa sesión, hora local de la
 * venta).
 *
 * "Jornada en curso" se interpreta como: hoy es el día calendario de una
 * sesión (sin importar la hora exacta de inicio/fin, que esta versión no
 * modela) — ahí aplica el intervalo más agresivo (5 min).
 */
export function pollIntervalMinutes(now: Date, nextSessionDate: Date | null): number {
  if (!nextSessionDate) {
    // Sin ninguna sesión futura resuelta todavía (o venta sin catálogo
    // publicado aún): chequear con el intervalo más relajado, para
    // detectar en cuanto la casa de ventas publique algo.
    return POLLING_TIERS_MINUTES.moreThan30Days;
  }

  const msPerHour = 60 * 60 * 1000;
  const msPerDay = 24 * msPerHour;

  const isSameCalendarDay =
    now.getUTCFullYear() === nextSessionDate.getUTCFullYear() &&
    now.getUTCMonth() === nextSessionDate.getUTCMonth() &&
    now.getUTCDate() === nextSessionDate.getUTCDate();

  if (isSameCalendarDay) {
    return POLLING_TIERS_MINUTES.sessionDayActive;
  }

  const hoursUntil = (nextSessionDate.getTime() - now.getTime()) / msPerHour;

  if (hoursUntil <= 0) {
    // La sesión ya pasó y no es "hoy" (venta de varios días, sesión
    // anterior ya cerrada) — se resuelve solo cuando haya una sesión
    // futura distinta; hasta entonces, intervalo relajado.
    return POLLING_TIERS_MINUTES.moreThan30Days;
  }
  if (hoursUntil <= 24) {
    return POLLING_TIERS_MINUTES.lastDayBeforeSession;
  }
  if (hoursUntil <= 7 * 24) {
    return POLLING_TIERS_MINUTES.between7DaysAnd24Hours;
  }
  if (hoursUntil <= 15 * 24) {
    return POLLING_TIERS_MINUTES.between15And7Days;
  }
  if (hoursUntil <= 30 * 24) {
    return POLLING_TIERS_MINUTES.between30And15Days;
  }
  return POLLING_TIERS_MINUTES.moreThan30Days;
}

export function shouldCheckNow(now: Date, lastCheckedAt: Date | null, nextSessionDate: Date | null): boolean {
  if (!lastCheckedAt) return true;
  const intervalMs = pollIntervalMinutes(now, nextSessionDate) * 60 * 1000;
  return now.getTime() - lastCheckedAt.getTime() >= intervalMs;
}
