import { fetchWithRetry } from "../util/httpRetry";

// ID REAL DEL CATÁLOGO DE KEENELAND, AUTOMÁTICO (2026-10-26, pedido de Ramon:
// "cuando hay catálogos publicados en las casas de venta deberían
// descargarse solos").
//
// Keeneland numera sus ventas de dos formas distintas: el número de la URL
// pública (/sales/2026/14/november-breeding-stock-sale/) y el número interno
// del archivo de catálogo (catalog-backend.keeneland.com/.../sale_data_133.json).
// NO son correlativos (2026: 12→132, 13→134, 14→133, 15→135), así que no se
// pueden deducir. Antes se cargaban a mano venta por venta, y cada venta nueva
// quedaba sin catálogo hasta que alguien lo hacía.
//
// La propia página pública de ventas de Keeneland trae, para cada venta, un
// bloque de datos con su ruta ("path":"/2026/14/november-breeding-stock-sale")
// y su "sale_id" interno (el número del archivo). Acá se lee ese bloque — el
// mismo dato que usa la web de Keeneland para pedir el catálogo; nada se
// adivina ni se prueba por fuerza bruta.

const ALL_SALES_URL = "https://www.keeneland.com/sales/all-sales/";
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: { ids: Map<string, string>; fetchedAt: number } | null = null;

/** Objeto JSON que encierra la posición `index` (por conteo de llaves). */
function enclosingObject(text: string, index: number): string | null {
  let depth = 0;
  let start = -1;
  for (let k = index; k >= 0; k--) {
    const c = text[k];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) { start = k; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, k + 1);
    }
  }
  return null;
}

/** Valor de `key` en el nivel superior del objeto (no en objetos anidados). */
function topLevelString(obj: string, key: string): string | null {
  let depth = 0;
  const needle = `"${key}":`;
  for (let k = 0; k < obj.length; k++) {
    const c = obj[k];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (depth === 1 && obj.startsWith(needle, k)) {
      const m = obj.slice(k + needle.length).match(/^"?([^",}\]]*)/);
      return m ? m[1] : null;
    }
  }
  return null;
}

/**
 * De la página de ventas de Keeneland: número público de venta → número
 * interno del archivo de catálogo. Pura (sin red) para poder probarla.
 */
export function parseKeenelandCatalogIds(html: string): Map<string, string> {
  // El bloque viene como JSON escapado dentro de un <script> (\"path\":\"...\").
  const text = html.replace(/\\\\"/g, '"').replace(/\\"/g, '"');
  const ids = new Map<string, string>();
  const pathRegex = /"path":"\/(\d{4})\/(\d+)\/[a-z0-9-]+"/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    const publicId = match[2];
    if (ids.has(publicId)) continue;
    const obj = enclosingObject(text, match.index);
    if (!obj) continue;
    const catalogId = topLevelString(obj, "sale_id");
    if (catalogId && /^\d+$/.test(catalogId)) ids.set(publicId, catalogId);
  }
  return ids;
}

/** Número interno del catálogo de una venta de Keeneland, o null si la página no lo trae. */
export async function resolveKeenelandCatalogId(publicSaleId: string): Promise<string | null> {
  if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    try {
      const response = await fetchWithRetry(ALL_SALES_URL, { headers: { Accept: "text/html" } });
      if (response.ok) {
        const ids = parseKeenelandCatalogIds(await response.text());
        if (ids.size > 0) cache = { ids, fetchedAt: Date.now() };
      }
    } catch (err) {
      console.error("[keeneland] No se pudo leer la página de ventas para resolver IDs de catálogo:", err);
    }
  }
  return cache?.ids.get(publicSaleId) ?? null;
}
