// Motor de puntuación — metodología nueva (2026-08-13): "NUEVO CABALLO
// REFERENTE Y SISTEMA DEFINITIVO DE ANÁLISIS IA". Reemplaza las 26
// subcategorías legado (Anatomía funcional 12 + Aplomos 7 + Marcha 7) por
// 9 parámetros de anatomía comparativa, agrupados en 3 VISTAS (no más
// "bloques anatómicos"): LATERAL, FRONTAL, POSTERIOR — una por cada foto
// del caballo referente. Marcha queda completamente afuera de este módulo
// (ver punto 12 de las instrucciones) — la evaluación de movimiento sigue
// existiendo en la app como criterio del comprador durante la inspección
// presencial, simplemente no alimenta este puntaje.
//
// Filas legado (methodologyVersion = null en AnalysisResult) siguen usando
// la forma vieja {functional, limb, gait} — ver git history de este archivo
// si hace falta reconstruir esa lógica; no se borra el historial, solo deja
// de generarse nueva.

export const LATERAL_TRAITS = ["proportions", "topline", "structure"] as const;
export const FRONTAL_TRAITS = ["alignment", "symmetry", "proportions"] as const;
export const POSTERIOR_TRAITS = ["alignment", "structure", "symmetry"] as const;

// Los 9 ids EXACTOS que se le piden a la IA en el prompt (ver prompt.ts) y
// que se guardan en AnalysisResult.conformationScoresJson para filas con
// methodologyVersion = METHODOLOGY_VERSION.
export const ALL_TRAIT_IDS: string[] = [
  ...LATERAL_TRAITS.map((t) => `lateral.${t}`),
  ...FRONTAL_TRAITS.map((t) => `frontal.${t}`),
  ...POSTERIOR_TRAITS.map((t) => `posterior.${t}`),
];

export const METHODOLOGY_VERSION = "rm-anatomical-2026-08";

export interface ConformationScores {
  lateral: Record<string, number>;
  frontal: Record<string, number>;
  posterior: Record<string, number>;
}

function clamped(value: number): number {
  return Math.min(Math.max(value, 0), 10);
}

export function emptyScores(): ConformationScores {
  const zero = (traits: readonly string[]) => Object.fromEntries(traits.map((t) => [t, 0]));
  return { lateral: zero(LATERAL_TRAITS), frontal: zero(FRONTAL_TRAITS), posterior: zero(POSTERIOR_TRAITS) };
}

export function setScore(scores: ConformationScores, traitId: string, value: number): void {
  const [view, trait] = traitId.split(".");
  const v = clamped(value);
  if (view === "lateral") scores.lateral[trait] = v;
  else if (view === "frontal") scores.frontal[trait] = v;
  else if (view === "posterior") scores.posterior[trait] = v;
}

function average(record: Record<string, number>): number {
  const values = Object.values(record);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function blockAverages(scores: ConformationScores) {
  return {
    lateral: average(scores.lateral),
    frontal: average(scores.frontal),
    posterior: average(scores.posterior),
  };
}

// Cortes de clasificación — instrucciones 2026-08-13, punto 11:
// EXCELENTE 8.5–10.0, BIEN 7.0–8.4, REVISAR 0.0–6.9. Fijos: no se
// recalibran automáticamente aunque pocos caballos de una venta lleguen a
// EXCELENTE (ver punto 11: "la calidad de la población evaluada no
// modifica el patrón RM").
export const CLASSIFICATION_THRESHOLDS = {
  excelenteMinimo: 8.5,
  bienMinimo: 7.0,
};

// Un bloque (=vista) sin foto válida NO se promedia como si valiera 0 — ver
// punto 13 de las instrucciones: "una fotografía faltante nunca debe
// recibir 0 puntos". El motor de análisis (anthropicClient.ts) fuerza los 3
// parámetros de una vista a 0.0 exactamente cuando esa vista no tiene foto
// válida (ni propia ni clasificada) — un análisis genuino, con foto válida,
// prácticamente nunca da 0 en los 3 parámetros de una vista a la vez, así
// que ">0" es el mismo indicador de "vista disponible" que ya usaba el
// motor legado para Marcha, sin necesidad de un campo booleano aparte.
export function overallScore(scores: ConformationScores): number {
  const { lateral, frontal, posterior } = blockAverages(scores);
  const available = [lateral, frontal, posterior].filter((v) => v > 0);
  if (available.length === 0) return 0;
  return available.reduce((a, b) => a + b, 0) / available.length;
}

export type Classification = "Comprar" | "Revisar" | "Descartar";

// Los valores de retorno son los mismos 3 strings legado ("Comprar" /
// "Revisar" / "Descartar") a propósito: es lo que persiste en
// AnalysisResult.classification, Hip.userDecision y lo que decodifica
// Classification.swift por su rawValue — cambiarlos rompería la carga de
// decisiones ya guardadas. La terminología nueva (EXCELENTE/BIEN/REVISAR)
// vive solo en la capa de presentación (L10n.Classification, ya actualizado
// desde 2026-08-11 a Excelente/Bien/Revisar).
export function classify(score: number): Classification {
  if (score >= CLASSIFICATION_THRESHOLDS.excelenteMinimo) return "Comprar";
  if (score >= CLASSIFICATION_THRESHOLDS.bienMinimo) return "Revisar";
  return "Descartar";
}
