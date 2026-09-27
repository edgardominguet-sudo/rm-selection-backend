// Ranking del Día — reglas de SELECCIÓN y ORDEN (2026-09-26, pedido
// explícito de Ramon: "TOP 10 REAL BASADO EXCLUSIVAMENTE EN ANÁLISIS IA").
//
// Módulo puro, sin base de datos: recibe los Hips de UNA jornada de UNA
// venta con su análisis vigente y devuelve el Top a guardar. Es la única
// fuente de verdad de qué entra al ranking y en qué orden — la usa
// rebuildRankingSnapshot (rankingService.ts), que es el único lugar que
// escribe el RankingSnapshot que lee GET /ranking. Separado en su propio
// archivo para poder probarlo con tests unitarios sin Postgres.
//
// Reglas:
//   1) Solo entra un Hip con un análisis de IA REALMENTE completado:
//      source = AI (nunca un puntaje cargado a mano), con la vista que
//      evalúa el método vigente marcada como disponible por el propio
//      motor (landmarksJson.<vista>.available === true) y un score
//      numérico real en (0, 10]. Pendiente, fallido, incompleto, sin
//      vista válida o score 0 => no entra. Nunca se completa con valores
//      provisionales, estimados, heredados ni por defecto.
//   2) El score es el MISMO que el usuario ve en la ficha del Hip: en modo
//      "solo lateral" es el promedio del bloque lateral (igual que
//      `viewAverage(.lateral)` en HipDetailView.swift), nunca un promedio
//      con frontal/posterior viejos. Con el modo apagado, overallScore.
//   3) Orden: score de mayor a menor. Solo si dos scores son EXACTAMENTE
//      iguales se desempata por quién completó su análisis primero
//      (analyzedAt) y, como último recurso, por id interno — criterios
//      neutros que nunca miran favoritos, precio, pedigree ni número de
//      Hip, y hacen que el orden sea siempre el mismo con los mismos datos.
//   4) Se corta en RANKING_TOP_SIZE. Si hay menos Hips válidos, se
//      devuelven menos — nunca se rellena.
import { blockAverages, classify, ConformationScores } from "./analysis/conformationScores";
import { RM_SINGLE_LATERAL_ANALYSIS_MODE } from "./analysis/analysisMode";

/** Tamaño máximo del Ranking del Día — regla de producto fija (no configurable por variable de entorno). */
export const RANKING_TOP_SIZE = 10;

export interface RankingAnalysisInput {
  source: string;
  overallScore: number;
  conformationScoresJson: unknown;
  landmarksJson: unknown;
  analyzedAt: Date;
}

export interface RankingCandidateInput<H, A extends RankingAnalysisInput = RankingAnalysisInput> {
  hipId: string;
  hip: H;
  analysis: A | null | undefined;
}

export interface RankedHip<H, A extends RankingAnalysisInput = RankingAnalysisInput> {
  hipId: string;
  hip: H;
  analysis: A;
  score: number;
  classification: string;
}

function viewWasEvaluated(landmarksJson: unknown, view: string): boolean {
  if (!landmarksJson || typeof landmarksJson !== "object") return false;
  const detail = (landmarksJson as Record<string, unknown>)[view];
  return !!detail && typeof detail === "object" && (detail as { available?: unknown }).available === true;
}

/**
 * Score IA válido para el Ranking del Día, o null si este análisis no
 * califica (ver reglas 1 y 2 arriba).
 */
export function rankingScoreFromAnalysis(analysis: RankingAnalysisInput | null | undefined): number | null {
  if (!analysis) return null;
  if (analysis.source !== "AI") return null;
  const evaluated = RM_SINGLE_LATERAL_ANALYSIS_MODE
    ? viewWasEvaluated(analysis.landmarksJson, "lateral")
    : ["lateral", "frontal", "posterior"].some((view) => viewWasEvaluated(analysis.landmarksJson, view));
  if (!evaluated) return null;

  let score: number;
  if (RM_SINGLE_LATERAL_ANALYSIS_MODE) {
    const scores = analysis.conformationScoresJson as ConformationScores | null;
    if (!scores || typeof scores !== "object") return null;
    score = blockAverages(scores).lateral;
  } else {
    score = analysis.overallScore;
  }
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  // Quita solo el ruido de coma flotante del promedio (9.299999999 vs
  // 9.3000001 para el MISMO puntaje real) para que un empate real se
  // reconozca como empate -- 3 decimales, muy por debajo de la precisión
  // del método (la app muestra 1 decimal), nunca cambia un score real.
  score = Math.round(score * 1000) / 1000;
  if (score <= 0 || score > 10) return null;
  return score;
}

/**
 * Selecciona y ordena el Top del Ranking del Día a partir de los Hips de
 * UNA jornada de UNA venta (el llamador ya filtró por saleId + día).
 * Devuelve también cuántos Hips de la jornada tienen un análisis IA
 * válido en total (puede ser mayor que el Top).
 */
export function selectRankingTop<H, A extends RankingAnalysisInput = RankingAnalysisInput>(
  candidates: ReadonlyArray<RankingCandidateInput<H, A>>,
  limit: number = RANKING_TOP_SIZE
): { top: RankedHip<H, A>[]; eligibleCount: number } {
  const eligible: RankedHip<H, A>[] = [];
  for (const candidate of candidates) {
    const score = rankingScoreFromAnalysis(candidate.analysis);
    if (score === null) continue;
    eligible.push({
      hipId: candidate.hipId,
      hip: candidate.hip,
      analysis: candidate.analysis!,
      score,
      classification: classify(score),
    });
  }
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byTime = a.analysis.analyzedAt.getTime() - b.analysis.analyzedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.hipId < b.hipId ? -1 : a.hipId > b.hipId ? 1 : 0;
  });
  return { top: eligible.slice(0, Math.max(0, limit)), eligibleCount: eligible.length };
}
