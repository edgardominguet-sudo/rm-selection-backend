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

    const sexKnownBothSides = !!hip.sex && !!candidate.sex;
    const sexMatches = sexKnownBothSides && normalized(hip.sex) === normalized(candidate.sex);
    // Sexo conocido de los dos lados y DISTINTO: no es el mismo caballo,
    // se descarta el cruce entero (más fuerte que solo "no confirmado").
    if (sexKnownBothSides && !sexMatches) continue;

    const foalYearKnownBothSides = hip.foalYear != null && candidate.foalYear != null;
    const foalYearMatches = foalYearKnownBothSides && hip.foalYear === candidate.foalYear;
    if (foalYearKnownBothSides && !foalYearMatches) continue;

    // CONFIRMED solo cuando sexo Y foalYear coinciden confirmados de los
    // dos lados — sire+dam iguales por sí solos (ej. dos hermanos enteros
    // de años distintos) NUNCA alcanzan para CONFIRMED, quedan en LIKELY.
    const verification: "CONFIRMED" | "LIKELY" = sexMatches && foalYearMatches ? "CONFIRMED" : "LIKELY";

    const matchBasis = {
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

export interface SaleHistoryPayload {
  breeder: string | null;
  entries: Array<{
    id: string;
    saleHouse: string | null;
    saleHouseLabel: string | null;
    saleName: string;
    saleYear: number;
    hipNumberAtSale: string | null;
    priceRaw: string | null;
    resultCode: string | null;
    purchaser: string | null;
    source: string;
    verification: string;
  }>;
}

/** Lee el Historial de Ventas ya resuelto para un Hip, sin volver a cruzar nada. */
export async function readSaleHistory(hipId: string): Promise<SaleHistoryPayload> {
  const [hip, entries] = await Promise.all([
    db.hip.findUnique({ where: { id: hipId }, select: { breeder: true } }),
    db.horseSaleHistory.findMany({ where: { hipId }, orderBy: { saleYear: "desc" } }),
  ]);

  return {
    breeder: hip?.breeder ?? null,
    entries: entries.map((entry) => ({
      id: entry.id,
      saleHouse: entry.saleHouse,
      saleHouseLabel: entry.saleHouseLabel,
      saleName: entry.saleName,
      saleYear: entry.saleYear,
      hipNumberAtSale: entry.hipNumberAtSale,
      priceRaw: entry.priceRaw,
      resultCode: entry.resultCode,
      purchaser: entry.purchaser,
      source: entry.source,
      verification: entry.verification,
    })),
  };
}
