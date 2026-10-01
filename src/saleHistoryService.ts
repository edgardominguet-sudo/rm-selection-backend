import { Hip, Sale } from "@prisma/client";
import { db } from "./db";

/**
 * Historial de Ventas: resuelve si un Hip ya pasó antes por otra venta,
 * cruzando SOLO contra catálogo que RM Selection ya tiene importado (ver
 * plan "RM Selection — Módulo de Historial de Ventas"). No llama a ninguna
 * fuente externa (Keeneland/Fasig-Tipton no exponen breeder/foalYear/color
 * ni historial en su API de catálogo — ver comentario en Hip.breeder,
 * schema.prisma) — esto queda como el primer paso, el más confiable: el
 * mismo caballo apareciendo dos veces en catálogo que nosotros mismos ya
 * importamos.
 *
 * Principio de evidencia (no mezclar dos caballos distintos): nunca cruza
 * por un solo dato. Como mínimo exige sire + dam iguales; sexo y foalYear
 * (cuando se conocen de los dos lados) suman a la confirmación o descartan
 * el cruce si no coinciden.
 */

type HipWithSale = Hip & { sale: Sale };

function normalized(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Año de nacimiento real: foalYear si la casa lo publica aparte, si no el
 * año de la fecha de nacimiento completa (Fasig-Tipton y OBS solo publican
 * la fecha). Nunca inventado: null si no hay ninguna de las dos.
 */
function foalYearOf(hip: Hip): number | null {
  if (hip.foalYear != null) return hip.foalYear;
  return hip.foalingDate ? hip.foalingDate.getUTCFullYear() : null;
}

/**
 * Sexo comparable entre casas ("C"/"COLT", "F"/"FILLY"...). Un potro
 * castrado o criptórquido más tarde (G/R) sigue siendo el mismo macho, así
 * que se compara como "C".
 */
function sexKey(raw: string | null | undefined): string | null {
  const first = raw?.trim().toUpperCase().charAt(0);
  if (!first) return null;
  return first === "G" || first === "R" ? "C" : first;
}

/** Mejor fecha disponible para ordenar cronológicamente dos Hips del mismo caballo. */
function bestKnownDate(hip: HipWithSale): Date | null {
  return hip.sessionDate ?? hip.sale.startDate ?? null;
}

/** Mejor año disponible para mostrar en el Historial de Ventas — nunca inventado, solo derivado de fechas reales que ya tenemos. */
function bestKnownYear(hip: HipWithSale): number {
  const date = bestKnownDate(hip);
  if (date) return date.getUTCFullYear();
  if (hip.sale.scheduleYear) return hip.sale.scheduleYear;
  // Último recurso: no hay ninguna fecha real resuelta todavía para esta
  // venta — se usa el año en que se importó el registro, mejor que dejar
  // el campo vacío (la columna es NOT NULL), pero se marca en el propio
  // dato de dónde salió vía verification/matchBasis, nunca se presenta
  // como una fecha de venta confirmada sin más.
  return hip.createdAt.getUTCFullYear();
}

interface SaleResultData {
  priceRaw?: string | null;
  purchaser?: string | null;
  soldAsCode?: string | null;
}

function saleResultOf(hip: Hip): SaleResultData | null {
  return (hip.saleResultJson as SaleResultData | null) ?? null;
}

/**
 * Re-resuelve el Historial de Ventas de un Hip cruzando contra el resto del
 * catálogo que ya tenemos en la base. Idempotente: se puede llamar tantas
 * veces como haga falta (después de cada sync de catálogo, o a pedido del
 * botón manual "Actualizar historial de ventas") sin generar duplicados,
 * gracias al @@unique de HorseSaleHistory.
 */
export async function resolveSaleHistoryForHip(hipId: string): Promise<void> {
  const hip = await db.hip.findUnique({ where: { id: hipId }, include: { sale: true } });
  if (!hip) return;

  const sire = normalized(hip.sire);
  const dam = normalized(hip.dam);
  // Sin sire Y dam no hay base confiable para cruzar — se corta acá en vez
  // de arriesgar un cruce por un solo dato (ej. mismo consignatario).
  if (!sire || !dam) return;

  const hipDate = bestKnownDate(hip);

  const candidates = await db.hip.findMany({
    where: {
      id: { not: hip.id },
      sire: { equals: hip.sire ?? undefined, mode: "insensitive" },
      dam: { equals: hip.dam ?? undefined, mode: "insensitive" },
    },
    include: { sale: true },
  });

  for (const candidate of candidates as HipWithSale[]) {
    // Solo interesa como "venta ANTERIOR" — si no se puede establecer con
    // confianza que el candidato es cronológicamente anterior a este Hip,
    // se lo salta en vez de arriesgar mostrar una venta futura como si
    // fuera parte del historial (se va a resolver solo más adelante,
    // cuando ambas fechas estén disponibles — ver estrategia de
    // actualización periódica).
    const candidateDate = bestKnownDate(candidate);
    if (!hipDate || !candidateDate || candidateDate.getTime() >= hipDate.getTime()) {
      continue;
    }

    const sexKnownBothSides = !!sexKey(hip.sex) && !!sexKey(candidate.sex);
    const sexMatches = sexKnownBothSides && sexKey(hip.sex) === sexKey(candidate.sex);
    if (sexKnownBothSides && !sexMatches) continue;

    // 2026-09-30 (Historial en la ventana del HIP): mismo padre + misma
    // madre NO alcanza — un hermano propio de otro año tiene exactamente
    // los mismos dos nombres. El año de nacimiento tiene que conocerse de
    // los dos lados y coincidir; si falta en cualquiera, no se cruza
    // (nunca se arriesga mezclar dos caballos distintos).
    const hipFoalYear = foalYearOf(hip);
    const candidateFoalYear = foalYearOf(candidate);
    const foalYearKnownBothSides = hipFoalYear != null && candidateFoalYear != null;
    const foalYearMatches = foalYearKnownBothSides && hipFoalYear === candidateFoalYear;
    if (!foalYearMatches) continue;

    // CONFIRMED solo cuando sexo Y foalYear coinciden confirmados de los
    // dos lados — sire+dam iguales por sí solos (ej. dos hermanos enteros
    // de años distintos) NUNCA alcanzan para CONFIRMED, quedan en LIKELY.
    const verification: "CONFIRMED" | "LIKELY" = sexMatches && foalYearMatches ? "CONFIRMED" : "LIKELY";

    const matchBasis = {
      // "v2" = reglas estrictas (padre + madre + mismo año de nacimiento).
      rule: "v2",
      sire: true,
      dam: true,
      sex: sexKnownBothSides ? sexMatches : null,
      foalYear: foalYearKnownBothSides ? foalYearMatches : null,
    };

    const saleResult = saleResultOf(candidate);
    const saleYear = bestKnownYear(candidate);

    await db.horseSaleHistory.upsert({
      where: {
        hipId_saleHouse_saleYear_hipNumberAtSale: {
          hipId: hip.id,
          saleHouse: candidate.sale.house,
          saleYear,
          hipNumberAtSale: candidate.hipNumber,
        },
      },
      create: {
        hipId: hip.id,
        sourceHipId: candidate.id,
        saleHouse: candidate.sale.house,
        saleName: candidate.sale.name,
        saleYear,
        hipNumberAtSale: candidate.hipNumber,
        priceRaw: saleResult?.priceRaw ?? null,
        resultCode: saleResult?.soldAsCode ?? null,
        purchaser: saleResult?.purchaser ?? null,
        source: "INTERNAL_HIP",
        verification,
        matchBasis,
        lastConfirmedAt: new Date(),
      },
      update: {
        sourceHipId: candidate.id,
        saleName: candidate.sale.name,
        priceRaw: saleResult?.priceRaw ?? null,
        resultCode: saleResult?.soldAsCode ?? null,
        purchaser: saleResult?.purchaser ?? null,
        verification,
        matchBasis,
        lastConfirmedAt: new Date(),
      },
    });
  }
}

/**
 * Recalcula desde cero el historial INTERNO de un Hip (borra solo las
 * entradas INTERNAL_HIP — nunca las cargadas a mano) — usado por el
 * relleno de historial y cuando cambian las reglas de cruce.
 */
export async function rebuildSaleHistoryForHip(hipId: string): Promise<void> {
  await db.horseSaleHistory.deleteMany({ where: { hipId, source: "INTERNAL_HIP" } });
  await resolveSaleHistoryForHip(hipId);
}

/** HIP Number -> cantidad de ventas anteriores, para toda una venta (una sola consulta liviana). */
export async function saleHistoryIndex(saleId: string): Promise<Record<string, number>> {
  const rows = await db.horseSaleHistory.groupBy({
    by: ["hipId"],
    where: { hip: { saleId } },
    _count: { _all: true },
  });
  if (rows.length === 0) return {};
  const hips = await db.hip.findMany({ where: { id: { in: rows.map((r) => r.hipId) } }, select: { id: true, hipNumber: true } });
  const numberById = new Map(hips.map((h) => [h.id, h.hipNumber]));
  const result: Record<string, number> = {};
  for (const row of rows) {
    const hipNumber = numberById.get(row.hipId);
    if (hipNumber) result[hipNumber] = row._count._all;
  }
  return result;
}

/**
 * Resultado normalizado de una aparición anterior — cada casa publica el
 * resultado distinto (Keeneland "R.N.A. (275,000)", Fasig-Tipton purchaser
 * "OUT" con precio 0, OBS con indicador de RNA...). Nunca inventa un monto:
 * solo el que la casa publicó.
 */
export function normalizeHistoryResult(
  priceRaw: string | null,
  purchaser: string | null,
  code: string | null
): { status: "SOLD" | "PS" | "RNA" | "OUT" | "NONE"; amount: number | null; buyer: string | null } {
  const price = priceRaw ? Number(String(priceRaw).replace(/[$,\s]/g, "")) : NaN;
  const hasPrice = Number.isFinite(price) && price > 0;
  const upperCode = code?.trim().toUpperCase() ?? "";
  const upperBuyer = purchaser?.trim().toUpperCase() ?? "";
  if (upperCode === "RNA" || upperBuyer.startsWith("R.N.A") || upperBuyer.startsWith("RNA")) {
    const match = purchaser?.match(/\(([\d,]+(?:\.\d+)?)\)/);
    // OBS publica la reserva de un RNA como monto negativo (ej. -90000);
    // Keeneland usa un centinela negativo chico (-2.00) que NO es un monto.
    const negativeReserve = Number.isFinite(price) && price <= -1000 ? -price : NaN;
    const reserve = match ? Number(match[1].replace(/,/g, "")) : hasPrice ? price : negativeReserve;
    return { status: "RNA", amount: Number.isFinite(reserve) && reserve > 0 ? reserve : null, buyer: null };
  }
  const isOut = ["OUT", "SCRATCHED", "WD", "WITHDRAWN"].includes(upperCode) || upperBuyer === "OUT";
  if (isOut && !hasPrice) return { status: "OUT", amount: null, buyer: null };
  if (hasPrice) {
    const buyer = purchaser && upperBuyer !== "OUT" ? purchaser.trim() : null;
    return { status: upperCode === "PS" ? "PS" : "SOLD", amount: price, buyer };
  }
  return { status: "NONE", amount: null, buyer: null };
}

export interface SaleHistoryPayload {
  breeder: string | null;
  entries: Array<{
    id: string;
    saleHouse: string | null;
    saleHouseLabel: string | null;
    saleName: string;
    saleYear: number;
    saleDate: string | null;
    hipNumberAtSale: string | null;
    priceRaw: string | null;
    resultCode: string | null;
    purchaser: string | null;
    status: "SOLD" | "PS" | "RNA" | "OUT" | "NONE";
    amount: number | null;
    buyer: string | null;
    source: string;
    verification: string;
  }>;
}

/** Lee el Historial de Ventas ya resuelto para un Hip (más reciente primero), sin volver a cruzar nada. */
export async function readSaleHistory(hipId: string): Promise<SaleHistoryPayload> {
  const [hip, entries] = await Promise.all([
    db.hip.findUnique({ where: { id: hipId }, select: { breeder: true } }),
    db.horseSaleHistory.findMany({
      where: { hipId },
      include: { sourceHip: { select: { sessionDate: true, sale: { select: { startDate: true } } } } },
    }),
  ]);
  const dateOf = (entry: (typeof entries)[number]): Date | null =>
    entry.sourceHip?.sessionDate ?? entry.sourceHip?.sale?.startDate ?? null;
  entries.sort((a, b) => {
    const ta = dateOf(a)?.getTime() ?? Date.UTC(a.saleYear, 0, 1);
    const tb = dateOf(b)?.getTime() ?? Date.UTC(b.saleYear, 0, 1);
    return tb - ta;
  });

  return {
    breeder: hip?.breeder ?? null,
    entries: entries.map((entry) => ({
      id: entry.id,
      saleHouse: entry.saleHouse,
      saleHouseLabel: entry.saleHouseLabel,
      saleName: entry.saleName,
      saleYear: entry.saleYear,
      saleDate: dateOf(entry)?.toISOString() ?? null,
      hipNumberAtSale: entry.hipNumberAtSale,
      priceRaw: entry.priceRaw,
      resultCode: entry.resultCode,
      purchaser: entry.purchaser,
      ...normalizeHistoryResult(entry.priceRaw, entry.purchaser, entry.resultCode),
      source: entry.source,
      verification: entry.verification,
    })),
  };
}
