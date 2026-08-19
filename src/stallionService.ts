import { db } from "./db";

/**
 * "Padrillos de primera generación de yearlings 2026" (2026-08-19).
 *
 * Ver comentario completo del modelo `Stallion` en schema.prisma para el
 * porqué de esta tabla (independiente de Hip/venta, cruzada por nombre).
 * Este archivo concentra: la normalización de nombre (para que el cruce
 * funcione igual sin importar mayúsculas/espacios de más entre casas de
 * venta), la consulta que expone el endpoint, y la lista inicial de
 * padrillos que se siembra en cada arranque (ver seed.ts).
 */

/**
 * Normaliza un nombre de padrillo para poder cruzarlo de forma consistente
 * — mayúsculas y espacios de más colapsados a uno solo. Se usa TANTO al
 * guardar (seed.ts) como al consultar, así "Cody's Wish", "CODY'S WISH " y
 * "cody's  wish" resuelven al mismo registro.
 */
export function normalizeStallionName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Devuelve los padrillos con primera generación de yearlings en el año
 * pedido (o todos los que tengan el atributo cargado, si no se pasa año) —
 * la app cachea esto localmente y cruza contra `Pedigree.sire` de cada Hip
 * para decidir el color en "Buscar padrillo". Se devuelve solo `name` +
 * `firstYearlingsYear`: el resto (source, fechas) es interno, no le hace
 * falta a la app.
 */
export async function listFirstYearlingStallions(year?: number) {
  const rows = await db.stallion.findMany({
    where: {
      firstYearlingsYear: year ?? { not: null },
    },
    select: { name: true, firstYearlingsYear: true },
    orderBy: { name: "asc" },
  });
  return rows;
}
