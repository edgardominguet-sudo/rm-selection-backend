// Protege las reglas del Ranking del Día (2026-09-26, pedido explícito de
// Ramon: "TOP 10 REAL BASADO EXCLUSIVAMENTE EN ANÁLISIS IA") — ver
// src/rankingSelection.ts.
import { RANKING_TOP_SIZE, rankingScoreFromAnalysis, selectRankingTop, RankingAnalysisInput } from "../../src/rankingSelection";
import { classify } from "../../src/analysis/conformationScores";

function lateralScores(value: number) {
  return { "lateral.proportions": value, "lateral.topline": value, "lateral.structure": value };
}

function aiAnalysis(score: number, overrides: Partial<RankingAnalysisInput> = {}): RankingAnalysisInput {
  return {
    source: "AI",
    overallScore: score,
    conformationScoresJson: lateralScores(score),
    landmarksJson: { lateral: { available: true }, frontal: { available: false }, posterior: { available: false } },
    analyzedAt: new Date("2026-09-26T12:00:00Z"),
    ...overrides,
  };
}

function candidate(id: string, analysis: RankingAnalysisInput | null) {
  return { hipId: id, hip: { hipNumber: id }, analysis };
}

describe("Ranking del Día — solo análisis IA completados con score válido", () => {
  test("el tamaño del ranking es 10", () => {
    expect(RANKING_TOP_SIZE).toBe(10);
  });

  test("un Hip sin análisis no entra", () => {
    expect(rankingScoreFromAnalysis(null)).toBeNull();
    expect(rankingScoreFromAnalysis(undefined)).toBeNull();
  });

  test("un puntaje cargado a mano (source MANUAL) no entra", () => {
    expect(rankingScoreFromAnalysis(aiAnalysis(9.5, { source: "MANUAL" }))).toBeNull();
  });

  test("un análisis sin la vista lateral evaluada (fallido/incompleto) no entra", () => {
    expect(rankingScoreFromAnalysis(aiAnalysis(9, { landmarksJson: { lateral: { available: false } } }))).toBeNull();
    expect(rankingScoreFromAnalysis(aiAnalysis(9, { landmarksJson: null }))).toBeNull();
    expect(rankingScoreFromAnalysis(aiAnalysis(9, { landmarksJson: { frontal: { available: true } } }))).toBeNull();
  });

  test("score 0, negativo, mayor a 10 o no numérico no entra", () => {
    expect(rankingScoreFromAnalysis(aiAnalysis(0))).toBeNull();
    expect(rankingScoreFromAnalysis(aiAnalysis(-1))).toBeNull();
    expect(rankingScoreFromAnalysis(aiAnalysis(10.5))).toBeNull();
    expect(rankingScoreFromAnalysis(aiAnalysis(9, { conformationScoresJson: null }))).toBeNull();
    expect(rankingScoreFromAnalysis(aiAnalysis(9, { conformationScoresJson: { "lateral.proportions": Number.NaN } }))).toBeNull();
  });

  test("el score es el lateral que ve el usuario, nunca un promedio con frontal/posterior viejos", () => {
    const legacy = aiAnalysis(8, {
      overallScore: 7.0, // promedio viejo con frontal/posterior
      conformationScoresJson: { ...lateralScores(9), "frontal.alignment": 5, "frontal.symmetry": 5, "frontal.proportions": 5 },
      landmarksJson: { lateral: { available: true }, frontal: { available: true } },
    });
    expect(rankingScoreFromAnalysis(legacy)).toBeCloseTo(9);
  });
});

describe("Ranking del Día — orden y corte", () => {
  test("ordena de mayor a menor score y corta en 10", () => {
    const scores = [7.1, 9.5, 8.2, 6.0, 9.9, 7.7, 8.8, 9.1, 6.6, 8.0, 7.4, 9.3, 5.5];
    const { top, eligibleCount } = selectRankingTop(scores.map((s, i) => candidate(`h${i}`, aiAnalysis(s))));
    expect(eligibleCount).toBe(scores.length);
    expect(top).toHaveLength(10);
    const got = top.map((t) => t.score);
    expect(got).toEqual([...scores].sort((a, b) => b - a).slice(0, 10));
  });

  test("con menos de 10 válidos devuelve solo esos, sin rellenar", () => {
    const list = [
      candidate("a", aiAnalysis(8)),
      candidate("b", null),
      candidate("c", aiAnalysis(9, { source: "MANUAL" })),
      candidate("d", aiAnalysis(7)),
      candidate("e", aiAnalysis(0)),
    ];
    const { top, eligibleCount } = selectRankingTop(list);
    expect(eligibleCount).toBe(2);
    expect(top.map((t) => t.hipId)).toEqual(["a", "d"]);
  });

  test("sin ningún análisis válido devuelve lista vacía", () => {
    const { top, eligibleCount } = selectRankingTop([candidate("a", null), candidate("b", aiAnalysis(0))]);
    expect(top).toEqual([]);
    expect(eligibleCount).toBe(0);
  });

  test("la clasificación sale del mismo score del ranking", () => {
    const { top } = selectRankingTop([candidate("a", aiAnalysis(9)), candidate("b", aiAnalysis(7.5)), candidate("c", aiAnalysis(4))]);
    for (const t of top) expect(t.classification).toBe(classify(t.score));
  });

  test("empate exacto: primero quien completó antes su análisis; orden estable con los mismos datos", () => {
    const early = aiAnalysis(9, { analyzedAt: new Date("2026-09-26T10:00:00Z") });
    const late = aiAnalysis(9, { analyzedAt: new Date("2026-09-26T11:00:00Z") });
    const one = selectRankingTop([candidate("z", late), candidate("y", early)]).top.map((t) => t.hipId);
    const two = selectRankingTop([candidate("y", early), candidate("z", late)]).top.map((t) => t.hipId);
    expect(one).toEqual(["y", "z"]);
    expect(two).toEqual(one);
  });

  test("el número de Hip nunca decide el orden", () => {
    const { top } = selectRankingTop([
      { hipId: "x1", hip: { hipNumber: "1" }, analysis: aiAnalysis(7) },
      { hipId: "x2", hip: { hipNumber: "999" }, analysis: aiAnalysis(8) },
    ]);
    expect(top.map((t) => t.hip.hipNumber)).toEqual(["999", "1"]);
  });
});
