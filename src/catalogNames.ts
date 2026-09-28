// Reglas puras de nombres del catálogo (2026-09-28, pedido de Ramon para
// Search). Sin base de datos ni red — se prueban con tests unitarios.
//
// 1) Consignor real ("consignorBase"). Las casas de ventas publican el
//    consignor junto con su ROL en esa venta: "Vinery Sales, Agent XVI",
//    "Colin Brennan Bloodstock at Highlander Training Center Agent V",
//    "Warrendale Sales, Agent for Stonestreet Bred & Raised". El rol
//    ("Agent", "Agent I", "Agent XVI", "Agent for ...") NO es otro
//    consignor: agrupar por el texto completo mostraba el mismo consignor
//    decenas de veces. OBS además publica el nombre ya separado
//    (`consignor_sort` / `property_line_1`) y ese dato de la fuente se usa
//    primero; esta regla es el respaldo genérico para cualquier otra casa o
//    venta futura, sin listas manuales.
//
// 2) Grand Sire desde el PDF de pedigree de OBS. En la página de cada HIP
//    los seis nombres del cuadro de pedigree salen con líneas de puntos y
//    SIEMPRE en este orden: padre del sire, madre del sire, padre de la
//    dam, madre de la dam, SIRE, DAM (verificado con HIPs reales de la
//    venta 155). Solo se acepta el resultado si el Sire y el Broodmare Sire
//    leídos del PDF coinciden con los del catálogo — si no coinciden, no se
//    devuelve nada (nunca se infiere ni se completa).

/** Rol de agente al final del nombre: ", Agent", " Agent V", ", AGENT XVI", ", Agent for X". */
const AGENT_SUFFIX = /(?:,\s*|\s+)Agent(?:\s+.*)?$/i;

/** Misma regla que AGENT_SUFFIX, en sintaxis de Postgres (se usa en SQL para filas guardadas antes de esta columna). */
export const AGENT_SUFFIX_SQL_PATTERN = "(,\\s*|\\s+)Agent(\\s+.*)?$";

/** Nombre real del consignor, sin su rol de agente. null si no queda nombre. */
export function consignorBaseName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s+/g, " ").replace(AGENT_SUFFIX, "").replace(/[\s,;]+$/, "").trim();
  return cleaned || null;
}

/** Código de estado/país de nacimiento tal como lo publica la fuente ("KY", "FL", "ON", "IRE"...). */
export function normalizeBredState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2,4}$/.test(code) ? code : null;
}

function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export interface PedigreeCross {
  sireSire: string;
  sireDam: string;
  damSire: string;
  damDam: string;
  sire: string;
  dam: string;
}

/** Los seis nombres del cuadro de pedigree de una página de OBS (líneas con puntos). */
export function parseObsPedigreeCross(text: string): PedigreeCross | null {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(.+?)\s*\.{5,}\s*$/);
    if (m && m[1].trim()) names.push(m[1].trim());
    if (names.length === 6) break;
  }
  if (names.length < 6) return null;
  const [sireSire, sireDam, damSire, damDam, sire, dam] = names;
  return { sireSire, sireDam, damSire, damDam, sire, dam };
}

/**
 * Grand Sire (padre del Sire) verificado contra el catálogo: el Sire del
 * PDF debe ser el Sire del catálogo, y el Broodmare Sire del PDF el del
 * catálogo (si el catálogo lo trae). Cualquier diferencia -> null.
 */
export function extractVerifiedGrandSire(text: string, expected: { sire: string; damSire?: string | null }): string | null {
  const cross = parseObsPedigreeCross(text);
  if (!cross) return null;
  if (nameKey(cross.sire) !== nameKey(expected.sire)) return null;
  if (expected.damSire && nameKey(cross.damSire) !== nameKey(expected.damSire)) return null;
  return cross.sireSire;
}
