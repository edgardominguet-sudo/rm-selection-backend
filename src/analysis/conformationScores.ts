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
// Forma de almacenamiento: PLANA — { "lateral.proportions": 8.0, ... } con
// las 9 claves con punto, EXACTAMENTE como responde la IA (ver prompt.ts,
// el JSON que se le pide) y exactamente como ya esperaba el cliente iOS
// (HipAnalysisSyncService.HipAnalysisDTO.conformationScoresJson: [String:
// Double], mismo patrón que usaba la metodología legado de 26 claves) — a
// propósito NO anidada por vista, para no tener que traducir de un lado al
// otro ni duplicar la definición de forma en dos lenguajes.
//
// Filas legado (methodologyVersion = null en AnalysisResult) también son
// planas, con las 26 claves viejas (functional.*/limb.*/gait.*) — ver git
// history de este archivo si hace falta reconstruir esa lógica; no se
// borra el historial, solo deja de generarse nueva.

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

export const METHODOLOGY_VERSION = "rm-anatomical-2026-08-19";

// Mapa plano id -> puntaje, las 9 claves de ALL_TRAIT_IDS (ver nota de
// forma de almacenamiento arriba).
export type ConformationScores = Record<string, number>;

function clamped(value: number): number {
  return Math.min(Math.max(value, 0), 10);
}

export function emptyScores(): ConformationScores {
  return Object.fromEntries(ALL_TRAIT_IDS.map((id) => [id, 0]));
}

export function setScore(scores: ConformationScores, traitId: string, value: number): void {
  scores[traitId] = clamped(value);
}

function averageForView(scores: ConformationScores, traits: readonly string[], view: string): number {
  const values = traits.map((t) => scores[`${view}.${t}`] ?? 0);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function blockAverages(scores: ConformationScores) {
  return {
    lateral: averageForView(scores, LATERAL_TRAITS, "lateral"),
    frontal: averageForView(scores, FRONTAL_TRAITS, "frontal"),
    posterior: averageForView(scores, POSTERIOR_TRAITS, "posterior"),
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

// Una vista sin foto válida NO se promedia como si valiera 0 — ver punto 13
// de las instrucciones: "una fotografía faltante nunca debe recibir 0
// puntos". El motor de análisis (anthropicClient.ts) fuerza los 3
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
