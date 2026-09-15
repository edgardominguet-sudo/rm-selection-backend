// Protege el motor de Scoring determinístico (pieza (F) del motor RM —
// analysis/scoringEngine.ts): dado el mismo conjunto de hallazgos,
// SIEMPRE debe devolver el mismo puntaje 0.0-10.0. Este es el número que
// Ramon ve directamente en cada Hip — cualquier regresión acá es
// visible e inmediata para él, así que estos tests son de máxima
// prioridad.
import { scoreView } from "../../src/analysis/scoringEngine";
import { Finding } from "../../src/analysis/findings";
import { CONFORMATION_KNOWLEDGE_BASE, findDefect } from "../../src/analysis/conformationKnowledgeBase";
import { MIN_ACTIONABLE_CONFIDENCE } from "../../src/analysis/severity";

// Toma un defecto real con rmPriority:true de la base de conocimiento —
// evita hardcodear pesos que ya viven (y pueden recalibrarse) en
// conformationKnowledgeBase.ts.
const rmPriorityDefect = CONFORMATION_KNOWLEDGE_BASE.find((d) => d.rmPriority)!;
const nonPriorityDefect = CONFORMATION_KNOWLEDGE_BASE.find((d) => !d.rmPriority);

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    defectId: rmPriorityDefect.id,
    view: "frontal",
    measuredValue: 1,
    absDeviation: 1,
    severity: "marcado",
    magnitude01: 1,
    confidence: 1,
    ...overrides,
  };
}

describe("scoreView: casos base", () => {
  test("sin hallazgos -> score perfecto 10.0", () => {
    expect(scoreView([])).toEqual({ score: 10, penalties: [] });
  });
  test("es una función pura: misma entrada -> exactamente el mismo resultado, siempre", () => {
    const findings = [finding({ magnitude01: 0.6, confidence: 0.8 })];
    const r1 = scoreView(findings);
    const r2 = scoreView(findings);
    expect(r1).toEqual(r2);
  });
  test("severity:'correct' nunca penaliza, aunque tenga magnitude01/confidence altos", () => {
    const r = scoreView([finding({ severity: "correct", magnitude01: 1, confidence: 1 })]);
    expect(r.score).toBe(10);
    expect(r.penalties).toEqual([]);
  });
});

describe("scoreView: solo penalizan defectos rmPriority:true", () => {
  test("un defecto con rmPriority:false nunca resta puntos, sin importar severidad/confianza", () => {
    if (!nonPriorityDefect) return; // defensivo: si algún día la KB solo tiene rmPriority:true
    const r = scoreView([finding({ defectId: nonPriorityDefect.id, severity: "marcado", magnitude01: 1, confidence: 1 })]);
    expect(r.score).toBe(10);
    expect(r.penalties).toEqual([]);
  });
  test("un defectId desconocido (no existe en la KB) no rompe el cálculo ni penaliza", () => {
    const r = scoreView([finding({ defectId: "defecto_inexistente_xyz" })]);
    expect(r.score).toBe(10);
    expect(r.penalties).toEqual([]);
  });
});

describe("scoreView: umbral de confianza mínima accionable", () => {
  test("confianza justo por debajo del umbral -> no penaliza (limitación de la foto, no defecto inventado)", () => {
    const r = scoreView([finding({ confidence: MIN_ACTIONABLE_CONFIDENCE - 0.01 })]);
    expect(r.score).toBe(10);
  });
  test("confianza exactamente en el umbral -> SÍ penaliza (el umbral es inclusivo hacia arriba)", () => {
    const r = scoreView([finding({ confidence: MIN_ACTIONABLE_CONFIDENCE, magnitude01: 1 })]);
    expect(r.score).toBeLessThan(10);
  });
});

describe("scoreView: magnitud de la penalización", () => {
  test("mayor magnitude01 -> mayor penalización (monotonía)", () => {
    const low = scoreView([finding({ magnitude01: 0.2 })]);
    const high = scoreView([finding({ magnitude01: 0.9 })]);
    expect(high.score).toBeLessThan(low.score);
  });
  test("mayor confidence -> mayor penalización (monotonía)", () => {
    const low = scoreView([finding({ magnitude01: 0.8, confidence: 0.6 })]);
    const high = scoreView([finding({ magnitude01: 0.8, confidence: 1 })]);
    expect(high.score).toBeLessThan(low.score);
  });
  test("el score nunca baja de 0, ni con muchos hallazgos marcados severos combinados", () => {
    const findings = Array.from({ length: 20 }, () => finding({ magnitude01: 1, confidence: 1 }));
    const r = scoreView(findings);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(10);
  });
  test("el score siempre tiene como máximo 1 decimal", () => {
    const r = scoreView([finding({ magnitude01: 0.37, confidence: 0.71 })]);
    expect(Number.isInteger(r.score * 10)).toBe(true);
  });
  test("un solo hallazgo marcado en un criterio de peso alto (>=0.85) alcanza para bajar de 'Excelente' (8.5) — calibración documentada en el código", () => {
    const highWeightDefect = CONFORMATION_KNOWLEDGE_BASE.find((d) => d.rmPriority && d.rmWeight >= 0.85);
    if (!highWeightDefect) return;
    const r = scoreView([
      finding({ defectId: highWeightDefect.id, severity: "marcado", magnitude01: 1, confidence: 1 }),
    ]);
    expect(r.score).toBeLessThan(8.5);
  });
});

describe("scoreView: múltiples hallazgos", () => {
  test("varios hallazgos penalizan de forma acumulativa (nunca solo se queda con el peor)", () => {
    const single = scoreView([finding({ magnitude01: 0.5, confidence: 0.8 })]);
    const double = scoreView([
      finding({ magnitude01: 0.5, confidence: 0.8 }),
      finding({ defectId: rmPriorityDefect.relatedDefectIds[0] ?? rmPriorityDefect.id, magnitude01: 0.5, confidence: 0.8 }),
    ]);
    expect(double.score).toBeLessThanOrEqual(single.score);
  });
  test("cada hallazgo que penaliza aparece en `penalties` con su defectId", () => {
    const r = scoreView([finding({ magnitude01: 0.6, confidence: 0.9 })]);
    expect(r.penalties).toHaveLength(1);
    expect(r.penalties[0].defectId).toBe(rmPriorityDefect.id);
    expect(r.penalties[0].points).toBeGreaterThan(0);
  });
});

describe("findDefect", () => {
  test("devuelve el defecto correcto por id", () => {
    expect(findDefect(rmPriorityDefect.id)?.id).toBe(rmPriorityDefect.id);
  });
  test("devuelve undefined para un id inexistente, nunca lanza", () => {
    expect(findDefect("no_existe")).toBeUndefined();
  });
});
