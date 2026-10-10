import { db } from "./db";
import type { Sale } from "@prisma/client";
import { startOfCalendarDay } from "./util/easternCalendarDay";

/**
 * VENTA ÚNICA "ACTIVA PARA AUTOMATIZACIÓN" (2026-09-17, a pedido explícito
 * de Ramon: "BARRIDO AUTOMÁTICO DE MEDIA SOLO PARA LA VENTA ACTIVA" — no
 * quiere que el job nocturno de las 3am recorra todas las ventas
 * cargadas, solo la que corresponda por fecha en cada momento).
 *
 * 100% CALCULADO en cada llamada, a partir de Sale.startDate/endDate —
 * a propósito NUNCA depende de ninguna bandera persistida que alguien
 * tenga que acordarse de apagar a mano. Cita textual del pedido: "no
 * quiero que dos o más ventas antiguas sigan siendo procesadas
 * simplemente porque alguna bandera anterior quedó activa". Por esto
 * mismo, un redeploy/restart/recovery (ver scheduler.ts,
 * catchUpMissedNightlySyncIfNeeded) es seguro sin ningún caso especial:
 * cualquiera sea el motivo por el que se dispara el job nocturno, siempre
 * vuelve a calcular la venta activa desde cero, en vez de asumir un
 * estado guardado que puede haber quedado desactualizado.
 *
 * CANDIDATAS: `isActive=true` (la venta sigue dada de alta normalmente,
 * visible en GET /sales — una venta archivada a mano con isActive=false,
 * ver comentario en routes.ts sobre altas duplicadas, nunca puede ser la
 * activa) y `catalogAccess=FULL` con `startDate` ya resuelto (las únicas
 * con una API de catálogo en vivo real contra la que barrear Media —
 * MANUAL_CSV/PENDING_ID/UNAVAILABLE no tienen ningún camino automático
 * legítimo, mismo criterio que ya usa mediaSweepService.ts).
 *
 * CRITERIO DE SELECCIÓN: entre las candidatas, se elige la de MENOR
 * distancia temporal entre "ahora" y su propio rango [startDate, endDate]
 * (`endDate` ausente = venta de un solo día, usa `startDate` como su
 * propio fin — mismo criterio que ya usa GET /sales para el cliente):
 *   - "ahora" DENTRO de [startDate, endDate] → distancia CERO — la venta
 *     está genuinamente en curso, gana siempre que exista una así.
 *   - "ahora" ANTES de startDate → distancia = startDate - ahora — venta
 *     futura, cuanto más próxima más prioridad.
 *   - "ahora" DESPUÉS de endDate → distancia = ahora - endDate — venta ya
 *     terminada, cuanto más reciente más prioridad, pero SIEMPRE pierde
 *     contra cualquier venta en curso o futura más próxima.
 * Este único número resuelve solo, sin reglas especiales para cada caso,
 * exactamente lo que pidió Ramon: mientras Keeneland September Yearling
 * Sale 2026 esté en curso (14–26 sept), gana con distancia cero; el día
 * que termine, la distancia de Keeneland empieza a crecer mientras la de
 * la próxima venta (California Fall Yearlings, 30 sept) empieza a bajar —
 * el cruce pasa solo, sin tocar ninguna bandera a mano; y una venta de
 * hace meses (ej. Fasig-Tipton — Saratoga, agosto) queda con una
 * distancia enorme, nunca vuelve a competir por accidente.
 *
 * Empate exacto en distancia (dos ventas realmente en curso al mismo
 * tiempo, caso raro pero posible entre casas distintas) se desempata de
 * forma determinística por `startDate` ascendente (la que arrancó
 * primero) — nunca por orden arbitrario de la base de datos.
 *
 * `null` = no hay ninguna venta candidata (ninguna isActive+FULL con
 * startDate resuelto) — el llamador debe tratarlo como "no hay nada que
 * barrer en esta corrida", nunca como error.
 */
export type SaleLifecycleStatus = "UPCOMING" | "ACTIVE" | "COMPLETED";

// Mismo margen de retención que RANKING_RETENTION_HOURS_AFTER_SESSION
// (rankingService.ts) / SESSION_RETENTION_HOURS_AFTER_END
// (rnaOfTheDayService.ts) — duplicado a propósito, mismo criterio que esos
// dos: este archivo no importa de rankingService.ts para no crear un ciclo
// (rankingService.ts YA importa resolveActiveSaleForAutomation desde acá).
const SALE_COMPLETION_RETENTION_HOURS = 2;

/**
 * Estado de ciclo de vida de una venta -- UPCOMING (todavía no arrancó),
 * ACTIVE (en curso), COMPLETED (ya terminó). Puramente derivado de
 * startDate/endDate, igual que el resto de esta clase -- no es un campo
 * guardado, así que nunca queda desincronizado. Usa el MISMO criterio de
 * "fin de jornada" que ya usa sessionExpiresAt en rankingService.ts /
 * rnaOfTheDayService.ts (fin del día calendario ET del último día de venta,
 * más el mismo margen de 2h), para que una venta no se declare COMPLETED a
 * la medianoche exacta de su último día si esa jornada sigue técnicamente
 * en curso.
 *
 * Agregado 2026-09-26 a pedido explícito de Ramon: los jobs automáticos
 * (catálogo, Media, IA, Ranking, RNA, resultados/scratches) NUNCA deben
 * seguir trabajando sobre una venta ya terminada, ni siquiera si
 * accidentalmente queda seleccionada como "la más cercana" -- ver uso en
 * resolveActiveSaleForAutomation(), syncCatalog(),
 * ensureSaleDaysForAllFullAccessSales(), syncLivePricesForActiveSessions y
 * mediaSweepService.ts.
 */
export function getSaleLifecycleStatus(
  sale: { startDate: Date | null; endDate: Date | null },
  now: Date = new Date()
): SaleLifecycleStatus {
  if (!sale.startDate) return "UPCOMING"; // todavía sin fecha -- nunca se considera terminada
  const end = sale.endDate ?? sale.startDate;
  const lastDayEnd = new Date(startOfCalendarDay(end).getTime() + 24 * 60 * 60 * 1000);
  const completionThreshold = new Date(lastDayEnd.getTime() + SALE_COMPLETION_RETENTION_HOURS * 60 * 60 * 1000);
  if (now >= completionThreshold) return "COMPLETED";
  if (now < sale.startDate) return "UPCOMING";
  return "ACTIVE";
}

export async function resolveActiveSaleForAutomation(): Promise<Sale | null> {
  const candidates = await db.sale.findMany({
    where: { isActive: true, catalogAccess: "FULL", startDate: { not: null } },
    orderBy: { startDate: "asc" },
  });
  if (candidates.length === 0) return null;

  const now = Date.now();
  let best: Sale | null = null;
  let bestDistance = Infinity;
  for (const sale of candidates) {
    // EXCLUSIÓN DURA 2026-09-26 (pedido explícito de Ramon, defensa en
    // profundidad): una venta COMPLETED nunca puede ganar la selección por
    // distancia, ni siquiera si es la candidata "más cercana" (ej. todas las
    // demás son futuras muy lejanas, o hay un error de carga de datos en
    // endDate). En la práctica el cálculo de distancia de abajo casi nunca
    // elegiría una venta terminada mientras haya una en curso/futura, pero
    // "casi nunca" no es una garantía -- esto la vuelve imposible.
    if (getSaleLifecycleStatus(sale, new Date(now)) === "COMPLETED") continue;
    const start = sale.startDate!.getTime();
    const end = (sale.endDate ?? sale.startDate!).getTime();
    let distance: number;
    if (now < start) distance = start - now;
    else if (now > end) distance = now - end;
    else distance = 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sale;
    }
  }
  return best;
}

/**
 * Ventas que trabaja el job NOCTURNO (catálogo/precios + barrido de fotos y
 * videos) — 2026-09-28, pedido de Ramon: "los barridos de nuevas fotos deben
 * hacerse en ambas ventas todas las noches, no alternadas". Antes el job
 * nocturno tomaba UNA sola venta (la más cercana por fecha) y, con dos
 * ventas pegadas (California Fall Yearlings 30/9 y OBS October 6-7/10), la
 * segunda quedaba sin actualizar hasta que terminaba la primera.
 *
 * Regla (100% por fecha, sin listas manuales): toda venta isActive + FULL
 * que NO esté terminada y que esté en curso o empiece dentro de los próximos
 * `NIGHTLY_AUTOMATION_WINDOW_DAYS` días, más siempre la más cercana (aunque
 * empiece más lejos). Nunca incluye ventas COMPLETED: las finalizadas quedan
 * guardadas como historial y no se vuelven a descargar ni barrer.
 */
// 10 días (no 7): OBS October (6/10) quedaba a 7,4 días de la corrida del
// 28/9 y se caía de la ventana; con 10 entra junto con California Fall
// Yearlings, que es lo pedido ("ambas ventas todas las noches").
export const NIGHTLY_AUTOMATION_WINDOW_DAYS = 10;

export async function resolveSalesForNightlyAutomation(now: Date = new Date()): Promise<Sale[]> {
  const candidates = await db.sale.findMany({
    where: { isActive: true, catalogAccess: "FULL", startDate: { not: null } },
    orderBy: { startDate: "asc" },
  });
  const windowEnd = now.getTime() + NIGHTLY_AUTOMATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const selected = candidates.filter(
    (sale) => getSaleLifecycleStatus(sale, now) !== "COMPLETED" && sale.startDate!.getTime() <= windowEnd
  );
  const nearest = await resolveActiveSaleForAutomation();
  if (nearest && !selected.some((sale) => sale.id === nearest.id)) selected.unshift(nearest);
  return selected;
}

/**
 * Ventas del BARRIDO DE FOTOS/VIDEOS de las 3am (2026-10-09, caso real:
 * "Kentucky October de Fasig-Tipton tiene muchos videos en su página y en
 * la app no están"). Causa: el barrido usaba la misma ventana de 10 días que
 * la sincronización de catálogo, pero las casas publican los videos con
 * semanas de anticipación — Kentucky October (19/10) quedaba fuera hasta el
 * 9/10 y sus videos no entraban.
 *
 * El barrido de Media es liviano (UNA consulta del catálogo por venta y solo
 * escribe los HIPs que cambiaron; nunca IA — Sale.autoAiAnalysisEnabled
 * nace en false), así que cubre toda venta FULL, NO terminada, que ya tenga
 * su catálogo cargado y empiece dentro de MEDIA_SWEEP_WINDOW_DAYS. Ventas
 * terminadas: nunca (quedan archivadas).
 */
export const MEDIA_SWEEP_WINDOW_DAYS = 45;

export async function resolveSalesForNightlyMediaSweep(now: Date = new Date()): Promise<Sale[]> {
  const windowEnd = new Date(now.getTime() + MEDIA_SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await db.sale.findMany({
    where: {
      isActive: true,
      catalogAccess: "FULL",
      startDate: { not: null, lte: windowEnd },
      hips: { some: {} },
    },
    orderBy: { startDate: "asc" },
  });
  const selected = candidates.filter((sale) => getSaleLifecycleStatus(sale, now) !== "COMPLETED");
  // Mismas ventas que el catálogo nocturno (por si alguna no cumpliera lo de arriba).
  for (const sale of await resolveSalesForNightlyAutomation(now)) {
    if (!selected.some((s) => s.id === sale.id)) selected.push(sale);
  }
  return selected.sort((a, b) => (a.startDate?.getTime() ?? 0) - (b.startDate?.getTime() ?? 0));
}
