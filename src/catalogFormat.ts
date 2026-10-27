import { NormalizedHip } from "./types";

// FORMATO ÚNICO DE CATÁLOGO (2026-10-26, pedido de Ramon: "corrígelo
// definitivamente para todas las casas y en todas las ventas futuras, no
// hagas parches").
//
// Cada casa publica los mismos datos con su propio estilo: Keeneland en
// minúsculas ("Pinehurst", "Pure Moon"), colores en palabras ("Dark
// Bay/Brown"), consignor con espacios de relleno y caballos sin nombre como
// "Hip 0001"; Fasig-Tipton en MAYÚSCULAS, colores en código ("CH", "DK B/" —
// cortado) y caballos sin nombre como "2025-RAVER". El servidor guardaba cada
// uno tal cual, y cada venta nueva de otra casa volvía a verse distinta.
//
// Regla (la referencia es Fasig-Tipton, como pidió Ramon el 2026-09-28): TODO
// HIP de CUALQUIER casa pasa por acá antes de guardarse (upsertNormalizedHips,
// el único punto de escritura de catálogo: sincronización en vivo e import
// manual), así ninguna casa ni venta futura puede saltearse el formato.
//   - Nombres (caballo, sire, dam, broodmare sire, consignor, criador):
//     MAYÚSCULAS, sin espacios de sobra.
//   - Sexo: código de una letra (C, F, G, R, H, M).
//   - Color: el juego canónico que ya usan Buscar y la app (Bay, Dark
//     Bay/Brown, Chestnut, Gray/Roan, Black). Un color desconocido se
//     conserva tal cual, en mayúsculas — nunca se pierde un dato.
//   - Caballo sin nombre: "AÑO-MADRE" (formato de Fasig-Tipton) en vez de
//     "Hip 0001" o vacío.

/** Color al juego canónico de la app (Bay, Dark Bay/Brown, Chestnut, Gray/Roan, Black); null si no se reconoce. */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase().replace(/\./g, "");
  if (!c) return null;
  if (c === "B" || c === "BAY") return "Bay";
  if (c === "CH" || c === "CHESTNUT") return "Chestnut";
  if (c === "BLK" || c === "BL" || c === "BLACK") return "Black";
  if (c.startsWith("GR") || c.includes("GRAY") || c.includes("GREY") || c.includes("ROAN")) return "Gray/Roan";
  if (c.startsWith("DB") || c.startsWith("DK") || c.includes("DARK BAY") || c.includes("BROWN") || c === "BR") return "Dark Bay/Brown";
  return null;
}

const SEX_CODES: Record<string, string> = {
  C: "C", COLT: "C",
  F: "F", FILLY: "F",
  G: "G", GELDING: "G",
  R: "R", RIDGLING: "R", RIG: "R",
  H: "H", HORSE: "H", STALLION: "H",
  M: "M", MARE: "M",
};

/** Texto limpio en mayúsculas; undefined si no queda nada. */
export function canonicalName(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const cleaned = raw.replace(/\s+/g, " ").trim().toUpperCase();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function canonicalSex(raw: string | null | undefined): string | undefined {
  const value = canonicalName(raw);
  if (!value) return undefined;
  return SEX_CODES[value.replace(/\./g, "")] ?? value;
}

export function canonicalColor(raw: string | null | undefined): string | undefined {
  const value = canonicalName(raw);
  if (!value) return undefined;
  return normalizeColor(value) ?? value;
}

/** Nombre de relleno que no es un nombre real ("Hip 0001", "HIP 12", "Unnamed", "TBA"). */
function isPlaceholderName(name: string): boolean {
  return /^(HIP\s*#?\s*\d+|UNNAMED|NO NAME|TBA|TBD|N\/A|-+)$/.test(name);
}

function birthYear(hip: NormalizedHip): number | undefined {
  if (hip.foalYear) return hip.foalYear;
  if (hip.foalingDate && !Number.isNaN(hip.foalingDate.getTime())) return hip.foalingDate.getUTCFullYear();
  return undefined;
}

export function canonicalHorseName(hip: NormalizedHip, dam: string | undefined): string | undefined {
  const name = canonicalName(hip.horseName);
  if (name && !isPlaceholderName(name)) return name;
  const year = birthYear(hip);
  if (year && dam) return `${year}-${dam}`;
  return name; // sin año o sin madre no se inventa nada: queda lo que vino.
}

/** Un HIP de cualquier casa, con el formato único de RM Selection. */
export function canonicalizeNormalizedHip(hip: NormalizedHip): NormalizedHip {
  const dam = canonicalName(hip.dam);
  return {
    ...hip,
    horseName: canonicalHorseName(hip, dam),
    sex: canonicalSex(hip.sex),
    sire: canonicalName(hip.sire),
    dam,
    damSire: canonicalName(hip.damSire),
    consignor: canonicalName(hip.consignor),
    consignorBase: canonicalName(hip.consignorBase),
    breeder: canonicalName(hip.breeder),
    color: canonicalColor(hip.color),
  };
}

/**
 * Plantilla de la URL del PDF de pedigree por HIP de una venta, a partir de
 * las URLs reales que publicó la casa ("…/pdfs/1.pdf" -> "…/pdfs/{hip}.pdf").
 * Solo se acepta si la URL termina en el número del propio HIP — nunca se
 * inventa. null si ningún HIP la trae.
 */
export function pedigreePdfTemplateFrom(hips: Array<{ hipNumber: string; pedigreePdfUrl?: string }>): string | null {
  for (const hip of hips) {
    const url = hip.pedigreePdfUrl?.trim();
    if (!url) continue;
    const suffix = `/${hip.hipNumber}.pdf`;
    if (url.toLowerCase().endsWith(suffix.toLowerCase())) {
      return `${url.slice(0, url.length - suffix.length)}/{hip}.pdf`;
    }
  }
  return null;
}
