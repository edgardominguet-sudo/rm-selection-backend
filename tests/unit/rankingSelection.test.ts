// Protege las reglas del Ranking del Día (2026-09-26, decisiones
// confirmadas por Ramon: "DECISIONES CONFIRMADAS – RANKING DEL DÍA") —
// fuente única en src/rankingSelection.ts.
import {
  RANKING_TOP_SIZE,
  compareHipNumbers,
  rankingGenerationAllowed,
  rankingScoreFromAnalysis,
  selectRankingTop,
  RankingAnalysisInput,
  RankingScope,
} from "../../src/rankingSelection";
import { classify } from "../../src/analysis/conformationScores";

const SALE = "sale-keeneland";
const OTHER_SALE = "sale-obs";
const DAY = new Date("2026-09-26T04:00:00Z"); // inicio del día calendario ET
const IN_DAY = new Date("2026-09-26T14:00:00Z");
const scope: RankingScope = { saleId: SALE, dayStart: DAY };

function ai(score: number, overrides: Partial<RankingAnalysisInput> = {}): RankingAnalysisInput {
  return {
    source: "AI",
    overallScore: score,
    conformationScoresJson: { "lateral.proportions": score, "lateral.topline": score, "lateral.structure": score },
    landmarksJson: { lateral: { available: true }, frontal: { available: false }, posterior: { available: false } },
    ...overrides,
  };
}

function hip(hipNumber: string, analysis: RankingAnalysisInput | null, over: { saleId?: string; sessionDate?: Date | null } = {}) {
  return {
    hipId: `id-${over.saleId ?? SALE}-${hipNumber}`,
    hip: { hipNumber, saleId: over.saleId ?? SALE, sessionDate: over.sessionDate === undefined ? IN_DAY : over.sessionDate },
    analysis,
  };
}

const numbers = (r: { top: Array<{ hip: { hipNumber: string } }> }) => r.top.map((t) => t.hip.hipNumber);

describe("Ranking del Día — análisis IA válido y vigente", () => {
  test("HIP sin analizar -> NO aparece", () => {
    const r = selectRankingTop([hip("1", null), hip("2", ai(8))], scope);
    expect(numbers(r)).toEqual(["2"]);
    expect(r.eligibleCount).toBe(1);
  });

  test("HIP analizado -> aparece según su score", () => {
    const r = selectRankingTop([hip("1", ai(7)), hip("2", ai(9)), hip("3", ai(8))], scope);
    expect(numbers(r)).toEqual(["2", "3", "1"]);
  });

  test("puntaje manual, lateral no evaluada, análisis incompleto o score 0/inválido -> NO aparece", () => {
    const invalid = [
      ai(9.5, { source: "MANUAL" }),
      ai(9, { landmarksJson: { lateral: { available: false } } }),
      ai(9, { landmarksJson: null }),
      ai(9, { landmarksJson: { frontal: { available: true } } }),
      ai(9, { conformationScoresJson: null }),
      ai(9, { conformationScoresJson: { "lateral.proportions": Number.NaN } }),
      ai(0),
      ai(-1),
      ai(10.5),
    ];
    for (const a of invalid) expect(rankingScoreFromAnalysis(a)).toBeNull();
    const r = selectRankingTop(invalid.map((a, i) => hip(String(i + 1), a)), scope);
    expect(r.top).toEqual([]);
    expect(r.eligibleCount).toBe(0);
  });

  test("el score es el lateral que ve el usuario, nunca un promedio con frontal/posterior viejos", () => {
    const legacy = ai(9, {
      overallScore: 7.0,
      conformationScoresJson: { "lateral.proportions": 9, "lateral.topline": 9, "lateral.structure": 9, "frontal.alignment": 5, "frontal.symmetry": 5, "frontal.proportions": 5 },
      landmarksJson: { lateral: { available: true }, frontal: { available: true } },
    });
    expect(rankingScoreFromAnalysis(legacy)).toBe(9);
  });

  test("la clasificación sale del mismo score del ranking", () => {
    const r = selectRankingTop([hip("1", ai(9)), hip("2", ai(7.5)), hip("3", ai(4))], scope);
    for (const t of r.top) expect(t.classification).toBe(classify(t.score));
  });
});

describe("Ranking del Día — reanálisis (siempre el resultado vigente)", () => {
  const base = () => Array.from({ length: 12 }, (_, i) => hip(String(i + 1), ai(8 + i * 0.1))); // 8.0 .. 9.1

  test("HIP reanalizado con score mayor -> entra y el ranking se reordena", () => {
    const before = selectRankingTop(base(), scope);
    expect(numbers(before)).not.toContain("1"); // 8.0 quedaba fuera del Top 10
    const after = selectRankingTop(base().map((c) => (c.hip.hipNumber === "1" ? hip("1", ai(9.8)) : c)), scope);
    expect(numbers(after)[0]).toBe("1");
    expect(after.top).toHaveLength(10);
    expect(numbers(after)).not.toContain("3"); // el más débil del Top anterior sale
  });

  test("HIP reanalizado con score menor -> baja y puede salir del Top", () => {
    const before = selectRankingTop(base(), scope);
    expect(numbers(before)[0]).toBe("12");
    const after = selectRankingTop(base().map((c) => (c.hip.hipNumber === "12" ? hip("12", ai(5)) : c)), scope);
    expect(numbers(after)).not.toContain("12");
    expect(numbers(after)).toContain("2"); // entra el siguiente mejor
  });

  test("HIP cuyo análisis vigente dejó de ser válido -> sale del Top", () => {
    const after = selectRankingTop(base().map((c) => (c.hip.hipNumber === "12" ? hip("12", ai(9.9, { landmarksJson: { lateral: { available: false } } })) : c)), scope);
    expect(numbers(after)).not.toContain("12");
  });
});

describe("Ranking del Día — empates, tamaño y orden", () => {
  test("empates -> número de HIP menor primero (ejemplo real 8.9)", () => {
    const r = selectRankingTop([hip("4604", ai(8.9)), hip("4562", ai(8.9)), hip("4303", ai(8.9)), hip("4585", ai(8.9))], scope);
    expect(numbers(r)).toEqual(["4303", "4562", "4585", "4604"]);
  });

  test("el desempate es numérico y estable con cualquier orden de entrada", () => {
    expect(compareHipNumbers("99", "100")).toBeLessThan(0);
    expect(compareHipNumbers("12", "12A")).toBeLessThan(0);
    const list = [hip("100", ai(8)), hip("99", ai(8)), hip("7", ai(8))];
    expect(numbers(selectRankingTop(list, scope))).toEqual(["7", "99", "100"]);
    expect(numbers(selectRankingTop([...list].reverse(), scope))).toEqual(["7", "99", "100"]);
  });

  test("el número de HIP nunca decide si los scores son distintos", () => {
    expect(numbers(selectRankingTop([hip("1", ai(7)), hip("999", ai(8))], scope))).toEqual(["999", "1"]);
  });

  test("más de 10 analizados -> solamente los 10 mejores, de mayor a menor", () => {
    const scores = [7.1, 9.5, 8.2, 6.0, 9.9, 7.7, 8.8, 9.1, 6.6, 8.0, 7.4, 9.3, 5.5];
    const r = selectRankingTop(scores.map((s, i) => hip(String(i + 1), ai(s))), scope);
    expect(RANKING_TOP_SIZE).toBe(10);
    expect(r.top).toHaveLength(10);
    expect(r.eligibleCount).toBe(13);
    expect(r.top.map((t) => t.score)).toEqual([...scores].sort((a, b) => b - a).slice(0, 10));
  });

  test("menos de 10 analizados -> solamente los existentes, sin rellenar", () => {
    const r = selectRankingTop([hip("1", ai(8)), hip("2", null), hip("3", ai(7)), hip("4", ai(0)), hip("5", ai(9, { source: "MANUAL" })), hip("6", ai(6))], scope);
    expect(numbers(r)).toEqual(["1", "3", "6"]);
    expect(r.eligibleCount).toBe(3);
  });

  test("ningún analizado -> lista vacía", () => {
    const r = selectRankingTop([hip("1", null), hip("2", null)], scope);
    expect(r.top).toEqual([]);
  });
});

describe("Ranking del Día — aislamiento por venta y jornada", () => {
  test("HIPs de otra venta -> NO aparecen aunque tengan mejor score", () => {
    const r = selectRankingTop([hip("1", ai(7)), hip("1", ai(9.9), { saleId: OTHER_SALE }), hip("50", ai(9.8), { saleId: OTHER_SALE })], scope);
    expect(r.top.map((t) => t.hip.saleId)).toEqual([SALE]);
    expect(r.eligibleCount).toBe(1);
  });

  test("HIPs de otro día de la misma venta, o sin fecha de jornada -> NO aparecen", () => {
    const r = selectRankingTop(
      [
        hip("1", ai(7)),
        hip("2", ai(9.9), { sessionDate: new Date("2026-09-25T14:00:00Z") }),
        hip("3", ai(9.9), { sessionDate: new Date("2026-09-27T05:00:00Z") }),
        hip("4", ai(9.9), { sessionDate: null }),
      ],
      scope
    );
    expect(numbers(r)).toEqual(["1"]);
  });
});

describe("Ranking del Día — cuándo se puede generar", () => {
  const base = {
    saleIsCompleted: false,
    saleIsActiveForAutomation: true,
    sessionStart: new Date("2026-09-26T14:00:00Z"),
    dayStart: DAY,
    leadHours: 12,
  };
  test("venta activa, dentro de la ventana -> sí", () => {
    expect(rankingGenerationAllowed({ ...base, now: new Date("2026-09-26T10:00:00Z") })).toBe(true);
  });
  test("venta terminada -> nunca (queda como historial)", () => {
    expect(rankingGenerationAllowed({ ...base, saleIsCompleted: true, now: new Date("2026-09-26T10:00:00Z") })).toBe(false);
  });
  test("otra venta que no es la activa -> nunca", () => {
    expect(rankingGenerationAllowed({ ...base, saleIsActiveForAutomation: false, now: new Date("2026-09-26T10:00:00Z") })).toBe(false);
  });
  test("antes de las 12h previas a la jornada -> todavía no", () => {
    expect(rankingGenerationAllowed({ ...base, now: new Date("2026-09-26T01:59:00Z") })).toBe(false);
    expect(rankingGenerationAllowed({ ...base, now: new Date("2026-09-26T02:00:00Z") })).toBe(true);
  });
  test("jornada vencida (fin del día + 2h) -> no", () => {
    expect(rankingGenerationAllowed({ ...base, now: new Date("2026-09-27T05:59:00Z") })).toBe(true);
    expect(rankingGenerationAllowed({ ...base, now: new Date("2026-09-27T06:00:00Z") })).toBe(false);
  });
});
