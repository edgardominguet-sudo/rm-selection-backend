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

type NormalizedStatus = "SOLD" | "RNA" | "SCRATCHED" | "OTHER";

/**
 * Normaliza el resultado oficial (código crudo + comprador + precio) a la
 * clasificación fija de 4 estados que usa RM Selection.
 *
 * Verificado contra datos reales de Fasig-Tipton Saratoga 2026
 * (2026-08-13): su `sold_as_code` NO indica vendido/RNA/retirado — viene
 * "Y" para prácticamente cualquier Hip con actividad registrada. El
 * estado real está codificado como TEXTO en el campo `purchaser`: "NOT
 * SOLD" (RNA), "OUT" (retirado/scratch), o el nombre real del comprador
 * (vendido). Por eso `purchaser` se revisa PRIMERO acá — no es un
 * capricho, es lo que la fuente realmente usa para publicar el estado.
 * `resultCode` (crudo) se revisa como respaldo para otras casas de
 * ventas (ej. Keeneland) que sí puedan usar códigos más directos.
 *
 * "OTHER" cubre cualquier caso que no calce con ninguno de los 3
 * conocidos — nunca se inventa un estado; el dato crudo (`resultCode`,
 * `purchaser`) queda guardado tal cual de todos modos.
 */
export function classifyResultCode(
  rawCode: string | null | undefined,
  priceRaw: string | null | undefined,
  purchaser: string | null | undefined
): NormalizedStatus | null {
  const buyer = purchaser?.trim().toUpperCase() ?? "";
  const code = rawCode?.trim().toUpperCase() ?? "";

  if (buyer === "NOT SOLD" || buyer === "RNA" || buyer.includes("RNA")) return "RNA";
  if (buyer === "OUT" || buyer === "SCRATCHED" || buyer === "WD" || buyer === "WITHDRAWN") return "SCRATCHED";
  // Cualquier otro texto no vacío en `purchaser` es, en la práctica, el
  // nombre real del comprador (agencia, stable, persona) — se interpreta
  // como vendido.
  if (buyer) return "SOLD";

  // Sin nada útil en `purchaser`: se cae al código crudo, por si otra casa
  // de ventas sí lo usa como estado directo.
  if (code === "RNA") return "RNA";
  if (code === "OUT" || code === "SCRATCHED" || code === "WD" || code === "WITHDRAWN" || code === "1" || code === "TRUE") return "SCRATCHED";
  if (code === "SOLD" || code === "PS" || code === "P/S") return "SOLD";

  // Sin comprador ni código reconocible, pero con precio real: se
  // interpreta como vendido (mismo criterio que ya usa SaleResult.swift
  // en el cliente iOS para el estado "sold").
  if (priceRaw) return "SOLD";
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
  const normalizedStatus = classifyResultCode(result?.soldAsCode, result?.priceRaw, result?.purchaser);

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
      // Crudo, tal cual lo publicó la casa — NUNCA la clasificación
      // inferida (ver comentario arriba de classifyResultCode).
      resultCode: result?.soldAsCode ?? null,
      purchaser: result?.purchaser ?? null,
      normalizedStatus: normalizedStatus ?? undefined,
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
      resultCode: result?.soldAsCode ?? null,
      purchaser: result?.purchaser ?? null,
      normalizedStatus: normalizedStatus ?? undefined,
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
  normalizedStatus: NormalizedStatus | null;
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
    normalizedStatus: r.normalizedStatus as NormalizedStatus | null,
    purchaser: r.purchaser,
    firstRecordedAt: r.firstRecordedAt,
    lastConfirmedAt: r.lastConfirmedAt,
  }));
}
