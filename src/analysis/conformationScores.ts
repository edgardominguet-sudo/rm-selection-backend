// Puerto de RMSelection/Models/ConformationScores.swift: 26 subcategorías
// en 3 bloques (Anatomía funcional 12, Aplomos 7, Marcha 7), cada bloque
// promediado y los 3 bloques pesados por igual (1/3 cada uno) para el
// puntaje general — misma fórmula exacta que usa la app.

export const FUNCTIONAL_TRAITS = [
  "head", "neck", "shoulder", "withers", "back", "loin",
  "croup", "hip", "muscling", "chest", "topline", "underline",
] as const;

export const LIMB_TRAITS = [
  "forelimbs", "hindlimbs", "knees", "hocks", "fetlocks", "pasterns", "hooves",
] as const;

export const GAIT_TRAITS = [
  "tracking", "balance", "strideLength", "impulsion", "coordination", "rhythm", "symmetry",
] as const;

// Los 26 ids EXACTOS que se le piden a la IA en el prompt (ver prompt.ts)
// y que se guardan en AnalysisResult.conformationScoresJson.
export const ALL_TRAIT_IDS: string[] = [
  ...FUNCTIONAL_TRAITS.map((t) => `functional.${t}`),
  ...LIMB_TRAITS.map((t) => `limb.${t}`),
  ...GAIT_TRAITS.map((t) => `gait.${t}`),
];

export interface ConformationScores {
  functional: Record<string, number>;
  limb: Record<string, number>;
  gait: Record<string, number>;
}

function clamped(value: number): number {
  return Math.min(Math.max(value, 0), 10);
}

export function emptyScores(): ConformationScores {
  const zero = (traits: readonly string[]) => Object.fromEntries(traits.map((t) => [t, 0]));
  return { functional: zero(FUNCTIONAL_TRAITS), limb: zero(LIMB_TRAITS), gait: zero(GAIT_TRAITS) };
}

export function setScore(scores: ConformationScores, traitId: string, value: number): void {
  const [block, trait] = traitId.split(".");
  const v = clamped(value);
  if (block === "functional") scores.functional[trait] = v;
  else if (block === "limb") scores.limb[trait] = v;
  else if (block === "gait") scores.gait[trait] = v;
}

function average(record: Record<string, number>): number {
  const values = Object.values(record);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function blockAverages(scores: ConformationScores) {
  return {
    functionalAnatomy: average(scores.functional),
    limbAlignment: average(scores.limb),
    gait: average(scores.gait),
  };
}

// Cortes de clasificación — 8.6 Comprar, >6.5 Revisar, resto Descartar.
export const CLASSIFICATION_THRESHOLDS = {
  comprarMinimo: 8.6,
  revisarMinimo: 6.5,
};

// CORRECCIÓN (2026-08-08 — puerto del fix ya aplicado en ConformationScores.swift
// el 2026-08-06): un bloque no evaluado de verdad (ej. Marcha sin video del Hip,
// ver anthropicClient.ts que fuerza gait.* a 0 en ese caso) NO se promedia como
// si valiera 0. Antes esta función siempre dividía por 3, así que un bloque
// faltante arrastraba el promedio para abajo de forma incorrecta — ej.
// (10 + 10 + 0) / 3 = 6.67 en vez de (10 + 10) / 2 = 10. Un puntaje genuino
// asignado por la IA mirando fotos/video reales prácticamente nunca da 0 en
// TODAS las subcategorías de un bloque a la vez, así que ">0" es el mismo
// indicador de "disponible" que usa la app — sin agregar un campo nuevo al
// modelo ni romper compatibilidad con análisis ya guardados.
export function overallScore(scores: ConformationScores): number {
  const { functionalAnatomy, limbAlignment, gait } = blockAverages(scores);
  const available = [functionalAnatomy, limbAlignment, gait].filter((v) => v > 0);
  if (available.length === 0) return 0;
  return available.reduce((a, b) => a + b, 0) / available.length;
}

export type Classification = "Comprar" | "Revisar" | "Descartar";

export function classify(score: number): Classification {
  if (score >= CLASSIFICATION_THRESHOLDS.comprarMinimo) return "Comprar";
  if (score > CLASSIFICATION_THRESHOLDS.revisarMinimo) return "Revisar";
  return "Descartar";
}
