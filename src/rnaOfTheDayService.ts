import { db } from "./db";
import { startOfCalendarDay, isSameEasternCalendarDay } from "./util/easternCalendarDay";

/**
 * "RNA del Día" (2026-09-15, a pedido explícito de Ramon, propuesta
 * aceptada tal cual): todos los Hips de una venta cuyo resultado en vivo
 * ya está confirmado como RNA ("Reserve Not Attained") por la propia casa
 * de ventas — mismo campo `Hip.saleResultJson.soldAsCode === "RNA"` que ya
 * alimenta Ranking del Día y la pestaña Decisión de cada Hip, nunca una
 * fuente nueva — agrupados por jornada real de venta (`Hip.sessionDate`).
 *
 * Puramente aditivo: este archivo SOLO LEE Hips ya sincronizados por el
 * pipeline existente (syncLivePricesForActiveSessions cada 10 min mientras
 * la jornada está en curso, más el barrido nocturno de catálogo) — no
 * agrega ningún job, tabla ni columna nueva, y no modifica ni un solo
 * campo de ningún Hip. No importa nada de rankingService.ts a propósito
 * (duplica la pequeña cuenta de "sesión en curso" más abajo) para que este
 * módulo no pueda romper ni depender de Ranking del Día.
 */

// Mismo criterio y mismo margen que RANKING_RETENTION_HOURS_AFTER_SESSION /
// sessionExpiresAt en rankingService.ts — duplicado a propósito (ver
// comentario de arriba).
const SESSION_RETENTION_HOURS_AFTER_END = 2;

function sessionExpiresAt(sessionDate: Date): Date {
    const dayEnd = new Date(startOfCalendarDay(sessionDate).getTime() + 24 * 60 * 60 * 1000);
    return new Date(dayEnd.getTime() + SESSION_RETENTION_HOURS_AFTER_END * 60 * 60 * 1000);
}

interface SaleResultJsonShape {
    priceRaw?: string;
    purchaser?: string;
    soldAsCode?: string;
}

function isRnaResult(raw: unknown): raw is SaleResultJsonShape & { soldAsCode: string } {
    if (!raw || typeof raw !== "object") return false;
    const code = (raw as SaleResultJsonShape).soldAsCode;
    return typeof code === "string" && code.trim().toUpperCase() === "RNA";
}

/**
 * Extrae el monto real que la casa de ventas publica para un Hip en RNA —
 * NUNCA un valor propio ni estimado. Keeneland no expone el último precio
 * ofrecido en un campo de precio dedicado (`field_price` siempre trae el
 * centinela "-2.00" para RNA, ver saleHouses/keeneland.ts `normalize()`);
 * en cambio lo escribe como texto dentro del campo que normalmente trae el
 * nombre del comprador (ej. "R.N.A. (950,000)") — confirmado 2026-09-15
 * contra el JSON real de la venta (Hip 0003 → exactamente ese texto, mismo
 * monto que ya se ve hoy en la pestaña Decisión de ese Hip, sub-línea de
 * `saleResult.purchaser`, ver SaleResultHeroCard en HipDetailView.swift).
 *
 * Esta función solo LEE ese texto ya sincronizado
 * (`Hip.saleResultJson.purchaser`) — no llama a ninguna fuente nueva ni
 * modifica el pipeline de sync existente. Devuelve el monto crudo tal como
 * aparece (con comas, sin `$`) para que el cliente lo formatee con el
 * mismo `SaleResult.formattedPrice(from:)` que ya usa el resto de la app —
 * `null` cuando el texto no trae ningún monto reconocible (ej. la casa de
 * ventas todavía no lo publicó para ese Hip): nunca se inventa ni se
 * estima un número en su lugar.
 */
export function parseRnaReserveAmountRaw(purchaser: string | null | undefined): string | null {
    if (!purchaser) return null;
    const match = purchaser.match(/\(([\d,]+(?:\.\d+)?)\)/);
    if (!match) return null;
    const cleaned = match[1].replace(/,/g, "");
    const value = Number(cleaned);
    return Number.isFinite(value) && value > 0 ? match[1] : null;
}

export interface RnaEntry {
    hipNumber: string;
    horseName: string | null;
    sire: string | null;
    dam: string | null;
    reserveAmountRaw: string | null;
}

export interface RnaDaySummary {
    date: Date;
    rnaCount: number;
}

export interface RnaDayDetail {
    date: Date;
    sessionInProgress: boolean;
    rnaCount: number;
    entries: RnaEntry[];
}

export interface RnaDelDiaResult {
    today: RnaDayDetail | null;
    previousDays: RnaDaySummary[];
}

interface HipRow {
    hipNumber: string;
    horseName: string | null;
    sire: string | null;
    dam: string | null;
    sessionDate: Date | null;
    saleResultJson: unknown;
}

function toEntry(hip: HipRow): RnaEntry {
    const json = hip.saleResultJson as SaleResultJsonShape | null;
    return {
          hipNumber: hip.hipNumber,
          horseName: hip.horseName,
          sire: hip.sire,
          dam: hip.dam,
          reserveAmountRaw: parseRnaReserveAmountRaw(json?.purchaser ?? null),
    };
}

function sortByHipNumber(entries: RnaEntry[]): RnaEntry[] {
    return [...entries].sort((a, b) => a.hipNumber.localeCompare(b.hipNumber, undefined, { numeric: true }));
}

function isSessionInProgress(sessionDate: Date, now: Date): boolean {
    return now.getTime() >= startOfCalendarDay(sessionDate).getTime() && now.getTime() < sessionExpiresAt(sessionDate).getTime();
}

/**
 * "RNA del Día" para una venta: la jornada EN CURSO (si hay alguna) con su
 * lista completa, más un resumen (solo fecha + cantidad, sin traer todas
 * las filas) de las jornadas anteriores que ya tuvieron algún RNA — para
 * que "Días anteriores" se pueda pintar liviano y cargar el detalle
 * completo de cada día recién al tocarlo (ver `getRnaDelDiaForDay`).
 */
export async function getRnaDelDia(saleId: string): Promise<RnaDelDiaResult> {
    const hips = await db.hip.findMany({
          where: { saleId, sessionDate: { not: null } },
          select: { hipNumber: true, horseName: true, sire: true, dam: true, sessionDate: true, saleResultJson: true },
    });

  const byDay = new Map<number, HipRow[]>();
    for (const hip of hips) {
          if (!isRnaResult(hip.saleResultJson)) continue;
          const key = hip.sessionDate!.getTime();
          const bucket = byDay.get(key);
          if (bucket) bucket.push(hip);
          else byDay.set(key, [hip]);
    }

  const now = new Date();
    let today: RnaDayDetail | null = null;
    const previousDays: RnaDaySummary[] = [];

  // Más reciente primero — la primera jornada de la lista cuya sesión
  // siga en curso ahora mismo es "hoy"; el resto (curse o no) cae en
  // "Días anteriores".
  const sortedDays = [...byDay.entries()].sort((a, b) => b[0] - a[0]);
    for (const [time, rows] of sortedDays) {
          const sessionDate = new Date(time);
          if (!today && isSessionInProgress(sessionDate, now)) {
                  today = {
date: sessionDate,
                      rnaCount: rows.length,
                            sessionInProgress: true,
                            entries: sortByHipNumber(rows.map(toEntry)),
                  };
          } else {
previousDays.push({ date: sessionDate, rnaCount: rows.length });
          }
    }

  return { today, previousDays };
}

/**
 * Detalle completo (todas las filas) de UNA jornada puntual — usado por
 * "Días anteriores" en RNA del Día, cargado bajo demanda recién al tocar
 * ese día (nunca se manda todo de una vez, ver comentario arriba).
 */
export async function getRnaDelDiaForDay(saleId: string, referenceInstant: Date): Promise<RnaDayDetail> {
    const hips = await db.hip.findMany({
          where: { saleId, sessionDate: { not: null } },
          select: { hipNumber: true, horseName: true, sire: true, dam: true, sessionDate: true, saleResultJson: true },
    });
    const rnaRows = hips.filter((h) => h.sessionDate && isSameEasternCalendarDay(h.sessionDate, referenceInstant) && isRnaResult(h.saleResultJson));
    return {
          date: rnaRows[0]?.sessionDate ?? referenceInstant,
          rnaCount: rnaRows.length,
          sessionInProgress: isSessionInProgress(referenceInstant, new Date()),
          entries: sortByHipNumber(rnaRows.map(toEntry)),
    };
}

/**
 * SOLO "Hoy" (2026-09-16, a pedido explícito de Ramon: "se esta tardando
 * mucho en abrir la lista de dias anteriores de los RNA, revisa que solo
 * se descargue una vez... el dia actual de la venta si debe hacer
 * barridos continuos cada 10 min en busca de nuevos RNA"). A diferencia de
 * `getRnaDelDia`/`getRnaDelDiaForDay` (que traen TODOS los Hips de la
 * venta con `sessionDate` no nulo, sin importar el día, para después
 * filtrar en memoria), esta función acota la consulta a la BASE DE DATOS
 * al rango exacto [medianoche ET, medianoche ET + 24h) del día que
 * contiene `referenceInstant` -- así el barrido periódico de "Hoy" (cada
 * 10 min mientras esa pantalla está abierta, ver RnaDelDiaService.swift)
 * nunca vuelve a escanear los miles de Hips de días anteriores/futuros de
 * la venta, solo los de la jornada de hoy. `Hip.sessionDate` vive anclado
 * a mediodía ET (nunca medianoche, ver comentario en fasigTipton.ts), así
 * que siempre cae DENTRO de este rango para su propio día calendario ET,
 * sin importar el horario de verano.
 *
 * Devuelve `null` únicamente cuando HOY no hay ninguna jornada en curso NI
 * ningún RNA registrado (nada que mostrar como "Hoy" en absoluto) — con
 * sesión en curso pero cero RNA todavía sí devuelve un detalle real
 * (`rnaCount: 0`), igual criterio que el resto de este archivo: nunca se
 * inventa ni se omite un estado real.
 */
export async function getRnaDelDiaToday(saleId: string, referenceInstant: Date): Promise<RnaDayDetail | null> {
    const dayStart = startOfCalendarDay(referenceInstant);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const hips = await db.hip.findMany({
        where: { saleId, sessionDate: { gte: dayStart, lt: dayEnd } },
        select: { hipNumber: true, horseName: true, sire: true, dam: true, sessionDate: true, saleResultJson: true },
    });
    const rnaRows = hips.filter((h) => isRnaResult(h.saleResultJson));
    const now = new Date();
    const sessionInProgress = hips.some((h) => h.sessionDate && isSessionInProgress(h.sessionDate, now));
    if (!sessionInProgress && rnaRows.length === 0) return null;
    return {
        date: rnaRows[0]?.sessionDate ?? hips[0]?.sessionDate ?? referenceInstant,
        rnaCount: rnaRows.length,
        sessionInProgress,
        entries: sortByHipNumber(rnaRows.map(toEntry)),
    };
}
