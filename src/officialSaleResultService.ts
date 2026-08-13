import { Hip, Sale } from "@prisma/client";
import { db } from "./db";

/**
 * Base histórica PROPIA de RM Selection (TAREA 1, 2026-08-13) — ver
 * comentario en OfficialSaleResult (schema.prisma) para la diferencia con
 * HorseSaleHistory. Este servicio es el único lugar que escribe en esa
 * tabla: se llama una vez por Hip en cada ciclo de sync de catálogo (ver
 * upsertNormalizedHips en rankingService.ts), y solo graba/actualiza una
 * fila cuando la casa de ventas YA publicó algo real (precio, comprador,
 * o un código de resultado tipo SOLD/RNA/OUT) — nunca crea una fila
 * "vacía" ni inventa un estado.
 *
 * Idempotente por diseño: la llave natural (casa + venta + año + Hip
 * Number) es la misma sin importar cuántas veces se vuelva a importar el
 * catálogo, así que un resync nunca duplica — solo actualiza
 * `lastConfirmedAt` y los campos si la casa de ventas corrigió algo
 * después de publicado (punto 8: "si la casa de venta modifica un
 * resultado después, actualizar el registro existente, nunca duplicado").
 */

interface RawSaleResult {
  priceRaw?: string | null;
  purchaser?: string | null;
  soldAsCode?: string | null;
}

function saleResultOf(hip: Hip): RawSaleResult | null {
  return (hip.saleResultJson as RawSaleResult | null) ?? null;
}

/**
 * Mejor año disponible para esta fila — misma lógica que
 * saleHistoryService.bestKnownYear (nunca inventado, solo derivado de
 * fechas reales que ya tenemos): sessionDate del Hip > startDate de la
 * venta > scheduleYear (solo Keeneland) > año de creación del registro
 * como último recurso.
 */
function bestKnownYear(hip: Hip, sale: Sale): number {
  const date = hip.sessionDate ?? sale.startDate;
  if (date) return date.getUTCFullYear();
  if (sale.scheduleYear) return sale.scheduleYear;
  return hip.createdAt.getUTCFullYear();
}

/**
 * Normaliza el código crudo de la casa de ventas (SOLD/RNA/OUT/etc, texto
 * libre según cada casa) a la clasificación fija de 4 estados que usa RM
 * Selection. "OTHER" cubre cualquier código publicado que no sea uno de
 * los 3 conocidos — se conserva el texto original en `resultCode` de
 * todos modos, así que no se pierde información aunque no se reconozca el
 * código.
 */
export function classifyResultCode(raw: string | null | undefined, priceRaw: string | null | undefined): "SOLD" | "RNA" | "SCRATCHED" | "OTHER" | null {
  const code = raw?.trim().toUpperCase();
  if (code === "RNA") return "RNA";
  if (code === "OUT" || code === "SCRATCHED" || code === "WD" || code === "WITHDRAWN") return "SCRATCHED";
  if (code === "SOLD" || code === "PS" || code === "P/S") return "SOLD";
  // Sin código pero con precio real: se interpreta como vendido (mismo
  // criterio que ya usa SaleResult.swift en el cliente iOS para el estado
  // "sold").
  if (!code && priceRaw) return "SOLD";
  if (code) return "OTHER";
  return null;
}

/**
 * Graba/actualiza en la base histórica permanente el resultado oficial de
 * UN Hip ya guardado — no hace nada si la casa de ventas todavía no
 * publicó ningún dato real (ni precio, ni comprador, ni código de
 * resultado): en ese caso no hay nada verificable que guardar todavía.
 */
export async function recordOfficialSaleResult(hip: Hip, sale: Sale): Promise<void> {
  const result = saleResultOf(hip);
  const hasRealData = !!(result?.priceRaw || result?.purchaser || result?.soldAsCode);
  if (!hasRealData) return;

  const saleYear = bestKnownYear(hip, sale);
  const resultCode = classifyResultCode(result?.soldAsCode, result?.priceRaw);

  await db.officialSaleResult.upsert({
    where: {
      saleHouse_saleName_saleYear_hipNumber: {
        saleHouse: sale.house,
        saleName: sale.name,
        saleYear,
        hipNumber: hip.hipNumber,
      },
    },
    create: {
      saleHouse: sale.house,
      saleName: sale.name,
      saleYear,
      hipNumber: hip.hipNumber,
      horseName: hip.horseName,
      sire: hip.sire,
      dam: hip.dam,
      consignor: hip.consignor,
      priceRaw: result?.priceRaw ?? null,
      resultCode: resultCode ?? (result?.soldAsCode ?? null),
      purchaser: result?.purchaser ?? null,
      sourceHipId: hip.id,
      lastConfirmedAt: new Date(),
    },
    update: {
      // horseName/sire/dam/consignor SÍ se actualizan: si el catálogo
      // trae un dato mejor que antes (ej. se completó el nombre del
      // caballo), se refleja acá también — nunca se sobreescriben con
      // null si la fuente ya no los trae (Prisma omite `undefined`).
      horseName: hip.horseName ?? undefined,
      sire: hip.sire ?? undefined,
      dam: hip.dam ?? undefined,
      consignor: hip.consignor ?? undefined,
      priceRaw: result?.priceRaw ?? null,
      resultCode: resultCode ?? (result?.soldAsCode ?? null),
      purchaser: result?.purchaser ?? null,
      sourceHipId: hip.id,
      lastConfirmedAt: new Date(),
    },
  });
}

export interface OfficialSaleResultRow {
  hipNumber: string;
  horseName: string | null;
  sire: string | null;
  dam: string | null;
  consignor: string | null;
  priceRaw: string | null;
  resultCode: string | null;
  purchaser: string | null;
  firstRecordedAt: Date;
  lastConfirmedAt: Date;
}

/** Lee la base histórica ya guardada para una venta puntual (casa+nombre+año) — sin volver a consultar nada externo. */
export async function readOfficialSaleResultsForSale(
  saleHouse: Sale["house"],
  saleName: string,
  saleYear: number
): Promise<OfficialSaleResultRow[]> {
  const rows = await db.officialSaleResult.findMany({
    where: { saleHouse, saleName, saleYear },
    orderBy: { hipNumber: "asc" },
  });
  return rows.map((r) => ({
    hipNumber: r.hipNumber,
    horseName: r.horseName,
    sire: r.sire,
    dam: r.dam,
    consignor: r.consignor,
    priceRaw: r.priceRaw,
    resultCode: r.resultCode,
    purchaser: r.purchaser,
    firstRecordedAt: r.firstRecordedAt,
    lastConfirmedAt: r.lastConfirmedAt,
  }));
}
