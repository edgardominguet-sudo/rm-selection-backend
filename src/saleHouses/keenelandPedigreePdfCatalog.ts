import { NormalizedHip } from "../types";

// MECANISMO DE RESPALDO para Keeneland (2026-08-14) — ver comentario largo
// en keeneland.ts (KeenelandClient.fetchCatalog) para el porqué.
//
// Keeneland publica, para cada Hip de una venta, un PDF público y SIN
// autenticación con el pedigree completo (árbol + registros de producción
// de varias generaciones) en:
//
//   https://secure.keeneland.com/sales/k{codigoDeVenta}/pdfs/{hipNumber}.pdf
//
// Se confirmó en vivo (2026-08-14) para DOS ventas reales distintas:
//   - September Yearling Sale 2025 (venta ya concluida): carpeta "k225"
//   - April Selected Horses of Racing Age Sale 2026: carpeta "k526"
//   - September Yearling Sale 2026 (la venta actual, todavía sin catálogo
//     en la API interna de Drupal /json/sale_api/get/catalog/12, que sigue
//     devolviendo 200 con body vacío): carpeta "k226" — CONFIRMADO real
//     descargando Hip 1, Hip 4650 (último del rango real, según el PDF
//     oficial "Hip Summary" que Keeneland ya publicó:
//     https://www.keeneland.com/files/HipGrouping202702.pdf) y confirmando
//     que Hip 185 (dentro de un hueco real entre sesiones, 182-189) no
//     existe — la numeración NO es continua, tal cual se esperaba.
//
// Patrón de la carpeta: "k" + código de tipo de venta (estable entre años
// para la MISMA venta, ej. September Yearling Sale siempre "2") + los
// últimos 2 dígitos del año. Nunca se inventa un código nuevo: solo se
// usan acá los que ya se probaron reales contra el servidor de Keeneland.
// Si en el futuro Keeneland agrega un tipo de venta yearling nuevo (hoy
// solo existe "September Yearling Sale" — el único que pasa el filtro
// /yearling/i de KeenelandDiscoveryClient), hay que confirmar su código
// una vez del mismo modo (probando Hip 1 en vivo) y agregarlo acá.
const SALE_TYPE_CODES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /september.*yearling/i, code: "2" },
  { pattern: /april.*selected.*horses.*of.*racing.*age/i, code: "5" },
];

/** Deriva "k{tipo}{YY}" a partir del nombre real de la venta + su año — nunca inventa un código no confirmado arriba. */
export function deriveKeenelandPedigreeSaleCode(saleName: string, year: number | null): string | null {
  if (!year) return null;
  const match = SALE_TYPE_CODES.find((entry) => entry.pattern.test(saleName));
  if (!match) return null;
  const yy = String(year % 100).padStart(2, "0");
  return `k${match.code}${yy}`;
}

function pedigreePdfUrl(saleCode: string, hipNumber: number): string {
  return `https://secure.keeneland.com/sales/${saleCode}/pdfs/${hipNumber}.pdf`;
}

/**
 * Descarga y extrae el texto plano de un PDF de pedigree de un Hip.
 * Devuelve null (no lanza error) si el Hip no existe en este catálogo —
 * eso es información válida (numeración no continua), no una falla.
 */
export async function fetchPedigreePdfText(saleCode: string, hipNumber: number): Promise<string | null> {
  const url = pedigreePdfUrl(saleCode, hipNumber);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/pdf" } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) return null;
  try {
    // Import perezoso: pdf-parse hace trabajo pesado al cargar (pdf.js) —
    // solo se paga ese costo cuando de verdad hace falta (fallback, no la
    // vía principal).
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return parsed.text;
  } catch (err) {
    console.error(`[keeneland-pedigree-pdf] No se pudo leer el PDF del Hip ${hipNumber} (${saleCode}):`, err);
    return null;
  }
}

const COLOR_SEX_LINE = /\n([A-Z][A-Z ]{2,30}?)\s+(COLT|FILLY|GELDING|RIG)\.?\s*\n/;
const FOALED_LINE = /Foaled\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/;
const CONSIGNOR_LINE = /Consigned by\s+([^\n]+)/;
// Ambas listas de caracteres incluyen paréntesis (2026-08-14, bug real
// encontrado probando el Hip 2300): varios caballos traen sufijo de país
// en el nombre — ej. dam "LOVEE DOVEE (GB)", damSire "Candy Ride (ARG)" —
// sin esto, el regex cortaba ahí y perdía Dam/DamSire enteros para
// cualquier Hip con un padre/madre nacido fuera de EE. UU.
const SIRE_LINE = /\bBy\s+([A-Z][A-Za-z'.\-() ]*?)\s*\(\d{4}\)\./;
const DAM_LINE = /1st dam\s*\n\s*([A-Z][A-Za-z' .()\-]*?),\s*by\s+([^.\n]+)\./;
const BARN_HIP_BLOCK = /Barn\s*\n([^\n]+)\s*\nHip No\.\s*\n\s*(\d+)/;

/** Extrae los campos que RM Selection necesita del texto plano del PDF de pedigree de un Hip. */
export function parseKeenelandPedigreePdfText(text: string, fallbackHipNumber: number): NormalizedHip {
  const colorSexMatch = COLOR_SEX_LINE.exec(text);
  const foaledMatch = FOALED_LINE.exec(text);
  const consignorMatch = CONSIGNOR_LINE.exec(text);
  const sireMatch = SIRE_LINE.exec(text);
  const damMatch = DAM_LINE.exec(text);
  const barnMatch = BARN_HIP_BLOCK.exec(text);

  const hipNumber = barnMatch ? barnMatch[2] : String(fallbackHipNumber);
  const foalYear = foaledMatch ? Number(foaledMatch[1].slice(-4)) : undefined;

  return {
    hipNumber,
    sex: colorSexMatch ? colorSexMatch[2] : undefined,
    color: colorSexMatch ? colorSexMatch[1].trim() : undefined,
    consignor: consignorMatch ? consignorMatch[1].trim() : undefined,
    // CORRECCIÓN 2026-08-15: el regex BARN_HIP_BLOCK ya capturaba el
    // establo (grupo 1) — se usaba SOLO para confirmar el número de Hip
    // (grupo 2), el valor del establo en sí nunca se copiaba al objeto
    // devuelto. Es el camino que trae hoy el catálogo real de Keeneland
    // September (4640 Hips, ver SaleOption.swift) mientras la API
    // estructurada de Keeneland siga sin publicar su catálogo.
    barn: barnMatch ? barnMatch[1].trim() : undefined,
    sire: sireMatch ? sireMatch[1].trim() : undefined,
    dam: damMatch ? damMatch[1].trim() : undefined,
    damSire: damMatch ? damMatch[2].trim() : undefined,
    foalYear: Number.isFinite(foalYear) ? foalYear : undefined,
    media: [],
  };
}

export interface PedigreePdfProbeOptions {
  /** Primer Hip Number a probar — casi siempre 1. */
  startAt?: number;
  /** Techo absoluto de seguridad (nunca se cruza, sin importar qué tan grande sea la venta real). */
  hardCap?: number;
  /** Cuántos Hips seguidos tienen que fallar para asumir que ya se llegó al final real del catálogo. Tiene que ser bastante mayor que cualquier hueco esperable dentro del rango (ver comentario de Hip 185 arriba). */
  maxConsecutiveMisses?: number;
  /** Cuántos Hips se piden en simultáneo — bajo a propósito, para no generar tráfico innecesario contra el servidor de Keeneland (ver instrucción #21 del propietario). */
  concurrency?: number;
  /** Callback opcional de progreso, para loguear cada tanto durante una corrida larga. */
  onProgress?: (found: number, lastNumberChecked: number) => void;
}

/**
 * Reconstruye el catálogo REAL de una venta de Keeneland probando, uno por
 * uno (con concurrencia acotada), los PDFs públicos de pedigree por Hip —
 * el único mecanismo confirmado real y funcionando HOY para September
 * Yearling Sale 2026, mientras la API interna de Drupal siga vacía. Nunca
 * asume numeración continua ni un tope fijo: se detiene sola cuando deja
 * de encontrar Hips reales.
 */
export async function probeKeenelandCatalogViaPedigreePdfs(
  saleCode: string,
  opts: PedigreePdfProbeOptions = {}
): Promise<NormalizedHip[]> {
  const startAt = opts.startAt ?? 1;
  const hardCap = opts.hardCap ?? 10000;
  const maxConsecutiveMisses = opts.maxConsecutiveMisses ?? 80;
  const concurrency = opts.concurrency ?? 6;

  const results: NormalizedHip[] = [];
  let consecutiveMisses = 0;
  let next = startAt;

  while (next <= hardCap && consecutiveMisses < maxConsecutiveMisses) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && next <= hardCap; i++, next++) {
      batch.push(next);
    }
    if (batch.length === 0) break;

    const texts = await Promise.all(batch.map((hipNumber) => fetchPedigreePdfText(saleCode, hipNumber)));

    for (let i = 0; i < batch.length; i++) {
      const text = texts[i];
      if (text) {
        results.push(parseKeenelandPedigreePdfText(text, batch[i]));
        consecutiveMisses = 0;
      } else {
        consecutiveMisses += 1;
      }
    }

    opts.onProgress?.(results.length, batch[batch.length - 1]);

    if (consecutiveMisses >= maxConsecutiveMisses) break;
  }

  return results;
}
