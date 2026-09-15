// Protege el sistema de Severidad + Confianza (pieza (E) del motor RM —
// analysis/severity.ts). Estos tests fijan el comportamiento de las 4
// bandas (correct/leve/moderado/marcado), el rol del caballo referente
// DENTRO de la banda "Correct" (corrección explícita de Ramon,
// 2026-08-14 — nunca debe poder mover el límite de seguridad anatómica),
// y el umbral de confianza mínima accionable.
import { classifySeverity, findingConfidence, MIN_ACTIONABLE_CONFIDENCE } from "../../src/analysis/severity";
import { ToleranceBands } from "../../src/analysis/conformationKnowledgeBase";

const bands: ToleranceBands = { unit: "degrees", correctoMax: 5, leveMax: 10, moderadoMax: 20 };

describe("classifySeverity: bandas base (sin referente)", () => {
  test("dentro de correctoMax -> correct", () => {
    const r = classifySeverity(3, bands);
    expect(r.severity).toBe("correct");
    expect(r.magnitude01).toBeGreaterThanOrEqual(0);
    expect(r.magnitude01).toBeLessThanOrEqual(0.15);
  });
  test("exactamente en el límite correctoMax -> todavía correct (<=)", () => {
    expect(classifySeverity(5, bands).severity).toBe("correct");
  });
  test("justo por encima de correctoMax -> leve", () => {
    const r = classifySeverity(5.1, bands);
    expect(r.severity).toBe("leve");
    expect(r.magnitude01).toBeGreaterThanOrEqual(0.15);
    expect(r.magnitude01).toBeLessThan(0.4);
  });
  test("en moderadoMax -> todavía moderado, no marcado", () => {
    expect(classifySeverity(20, bands).severity).toBe("moderado");
  });
  test("justo por encima de moderadoMax -> marcado", () => {
    const r = classifySeverity(20.1, bands);
    expect(r.severity).toBe("marcado");
    expect(r.magnitude01).toBeGreaterThanOrEqual(0.75);
  });
  test("marcado se satura en 1.0 a partir de 2x moderadoMax, sin romperse con valores extremos", () => {
    expect(classifySeverity(40, bands).magnitude01).toBeCloseTo(1, 6);
    expect(classifySeverity(1000, bands).magnitude01).toBeCloseTo(1, 6); // nunca > 1, nunca NaN
  });
  test("la severidad es simétrica (desviación negativa se trata igual que positiva)", () => {
    expect(classifySeverity(-8, bands)).toEqual(classifySeverity(8, bands));
  });
});

describe("classifySeverity: caballo referente (SOLO dentro de la banda Correct)", () => {
  test("con referente=0 (igual al ideal abstracto), medición=0 -> magnitude01=0", () => {
    expect(classifySeverity(0, bands, 0).magnitude01).toBeCloseTo(0, 6);
  });
  test("medición igual al referente -> magnitude01=0, aunque ambos estén desviados del 0 abstracto", () => {
    const r = classifySeverity(4, bands, 4);
    expect(r.severity).toBe("correct");
    expect(r.magnitude01).toBeCloseTo(0, 6);
  });
  test("el referente se recorta a los límites de la banda Correct — nunca puede mover el límite de seguridad hacia afuera", () => {
    // Referente fuera de la banda Correct (10, pero correctoMax=5): se
    // recorta a 5. Una medición de 5 (el límite real) debe dar
    // magnitude01=0 -> tan cerca del patrón RM como sea posible dentro
    // de la banda, NUNCA se "estira" la banda para que 10 sea correcto.
    const r = classifySeverity(5, bands, 10);
    expect(r.severity).toBe("correct");
    expect(r.magnitude01).toBeCloseTo(0, 6);
    // Una medición de 5.1 (fuera de la banda) sigue siendo "leve" pase lo
    // que pase con el referente — el referente NUNCA participa fuera de
    // la banda Correct.
    expect(classifySeverity(5.1, bands, 10).severity).toBe("leve");
  });
  test("el referente NO participa fuera de la banda Correct: mismo resultado con o sin referente", () => {
    const withRef = classifySeverity(15, bands, 4);
    const withoutRef = classifySeverity(15, bands);
    expect(withRef).toEqual(withoutRef);
  });
  test("referente null/undefined/NaN se ignora, comportamiento igual que sin referente", () => {
    const base = classifySeverity(3, bands);
    expect(classifySeverity(3, bands, null)).toEqual(base);
    expect(classifySeverity(3, bands, undefined)).toEqual(base);
    expect(classifySeverity(3, bands, NaN)).toEqual(base);
  });
});

describe("findingConfidence", () => {
  test("toma el mínimo entre confianza de landmarks y de la vista", () => {
    expect(findingConfidence(0.9, 0.6)).toBe(0.6);
    expect(findingConfidence(0.4, 0.95)).toBe(0.4);
  });
});

describe("MIN_ACTIONABLE_CONFIDENCE", () => {
  test("es un umbral fijo conocido — un cambio accidental acá afecta silenciosamente qué hallazgos penalizan el score en toda la app", () => {
    expect(MIN_ACTIONABLE_CONFIDENCE).toBe(0.55);
  });
});
