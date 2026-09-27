// Ranking del Día — FUENTE ÚNICA DE VERDAD (2026-09-26, decisiones
// confirmadas por Ramon: "TOP 10 REAL BASADO EXCLUSIVAMENTE EN ANÁLISIS
// IA" + "DECISIONES CONFIRMADAS – RANKING DEL DÍA").
//
// Todo lo que decide el Ranking del Día vive acá y solo acá:
//   - score vigente y estado de análisis válido .... rankingScoreFromAnalysis
//   - venta y fecha correspondientes ............... selectRankingTop (scope)
//                                                    + rankingGenerationAllowed
//   - orden y tamaño ............................... selectRankingTop
// rankingService.ts (rebuildRankingSnapshot / processSale) solo lee de la
// base y guarda lo que estas funciones devuelven. Módulo puro, sin base de
// datos, para poder probar cada regla con tests unitarios.
//
// Reglas:
//   1) Solo entra un Hip con un análisis de IA VÁLIDO y COMPLETADO, y
//      siempre el VIGENTE (CurrentHipAnalysis): source = AI (nunca un
//      puntaje manual), con la vista que evalúa el método vigente marcada
//      como disponible por el propio motor (landmarksJson.<vista>.available
//      === true) y un score numérico real en (0, 10]. Sin análisis,
//      pendiente, fallido, incompleto o score 0 => no entra. Nunca scores
//      inventados, provisionales ni históricos ya reemplazados: el ranking
//      se recalcula de cero en cada corrida (no hay "ranking congelado").
//   2) El score es el MISMO que el usuario ve en la ficha del Hip: en modo
//      "solo lateral" el promedio del bloque lateral (igual que
//      `viewAverage(.lateral)` en HipDetailView.swift).
//   3) Orden: score de mayor a menor. Empate EXACTO: número de Hip de
//      menor a mayor (decisión de Ramon), determinista y permanente.
//   4) Máximo RANKING_TOP_SIZE (10). Con menos Hips válidos se muestran
//      menos — nunca se rellena.
//   5) Solo Hips de LA venta y LA jornada (día calendario ET) del ranking.
//      Un ranking solo se genera para la venta activa, dentro de su ventana
//      (desde RANKING_LEAD_HOURS antes de la jornada hasta 2h después de
//      terminado ese día) y nunca para una venta terminada.
import { blockAverages, classify, ConformationScores } from "./analysis/conformationScores";
import { RM_SINGLE_LATERAL_ANALYSIS_MODE } from "./analysis/analysisMode";

/** Tamaño máximo del Ranking del Día — regla de producto fija (no configurable por variable de entorno). */
export const RANKING_TOP_SIZE = 10;

/** Margen después de terminado el día de la jornada durante el cual su ranking sigue vigente (luego se borra). */
export const RANKING_RETENTION_HOURS_AFTER_SESSION = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RankingAnalysisInput {
  source: string;
  overallScore: number;
  conformationScoresJson: unknown;
  landmarksJson: unknown;
}

export interface RankingHipInput {
  hipNumber: string;
  saleId: string;
  sessionDate: Date | null;
}

export interface RankingCandidateInput<H extends RankingHipInput, A extends RankingAnalysisInput = RankingAnalysisInput> {
  hipId: string;
  hip: H;
  analysis: A | null | undefined;
}

export interface RankedHip<H extends RankingHipInput, A extends RankingAnalysisInput = RankingAnalysisInput> {
  hipId: string;
  hip: H;
  analysis: A;
  score: number;
  classification: string;
}

/** Venta + jornada a la que pertenece un ranking. `dayStart` es el inicio del día calendario ET. */
export interface RankingScope {
  saleId: string;
  dayStart: Date;
}

function viewWasEvaluated(landmarksJson: unknown, view: string): boolean {
  if (!landmarksJson || typeof landmarksJson !== "object") return false;
  const detail = (landmarksJson as Record<string, unknown>)[view];
  return !!detail && typeof detail === "object" && (detail as { available?: unknown }).available === true;
}

/**
 * Score IA vigente y válido para el Ranking del Día, o null si este
 * análisis no califica (reglas 1 y 2).
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
 * Desempate por número de Hip, de menor a mayor. Compara la parte numérica
 * como número ("99" < "100") y, si coincide, el texto completo (ej. "12"
 * < "12A") — siempre el mismo resultado para los mismos Hips.
 */
export function compareHipNumbers(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** true si el Hip pertenece a la venta y jornada (día calendario) del ranking. */
export function hipBelongsToScope(hip: RankingHipInput, scope: RankingScope): boolean {
  if (hip.saleId !== scope.saleId || !hip.sessionDate) return false;
  const t = hip.sessionDate.getTime();
  return t >= scope.dayStart.getTime() && t < scope.dayStart.getTime() + DAY_MS;
}

/**
 * Selecciona y ordena el Top del Ranking del Día de UNA venta y UNA
 * jornada. Cualquier Hip de otra venta u otro día que llegue en
 * `candidates` se descarta acá (regla 5), aunque el llamador ya filtre en
 * la consulta. Devuelve también cuántos Hips de la jornada tienen un
 * análisis IA válido en total (puede ser mayor que el Top).
 */
export function selectRankingTop<H extends RankingHipInput, A extends RankingAnalysisInput = RankingAnalysisInput>(
  candidates: ReadonlyArray<RankingCandidateInput<H, A>>,
  scope: RankingScope,
  limit: number = RANKING_TOP_SIZE
): { top: RankedHip<H, A>[]; eligibleCount: number } {
  const eligible: RankedHip<H, A>[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.hipId)) continue;
    if (!hipBelongsToScope(candidate.hip, scope)) continue;
    const score = rankingScoreFromAnalysis(candidate.analysis);
    if (score === null) continue;
    seen.add(candidate.hipId);
    eligible.push({
      hipId: candidate.hipId,
      hip: candidate.hip,
      analysis: candidate.analysis!,
      score,
      classification: classify(score),
    });
  }
  eligible.sort((a, b) => (b.score !== a.score ? b.score - a.score : compareHipNumbers(a.hip.hipNumber, b.hip.hipNumber)));
  return { top: eligible.slice(0, Math.max(0, limit)), eligibleCount: eligible.length };
}

/** Momento a partir del cual el ranking de una jornada vence (fin de ese día + margen). */
export function rankingExpiresAt(dayStart: Date): Date {
  return new Date(dayStart.getTime() + DAY_MS + RANKING_RETENTION_HOURS_AFTER_SESSION * 60 * 60 * 1000);
}

/**
 * ¿Se puede generar/actualizar AHORA el ranking de esta jornada? Única
 * regla de "venta y fecha correspondientes" para generar (regla 5):
 *   - la venta no está terminada (COMPLETED -> queda como historial);
 *   - es la venta activa para la automatización (nunca otra venta);
 *   - ya se abrió la ventana: faltan RANKING_LEAD_HOURS o menos para el
 *     inicio de la jornada (`sessionStart`);
 *   - la jornada todavía no venció (fin del día + margen).
 */
export function rankingGenerationAllowed(input: {
  saleIsCompleted: boolean;
  saleIsActiveForAutomation: boolean;
  sessionStart: Date;
  dayStart: Date;
  now: Date;
  leadHours: number;
}): boolean {
  if (input.saleIsCompleted) return false;
  if (!input.saleIsActiveForAutomation) return false;
  const now = input.now.getTime();
  if (now < input.sessionStart.getTime() - input.leadHours * 60 * 60 * 1000) return false;
  if (now >= rankingExpiresAt(input.dayStart).getTime()) return false;
  return true;
}
