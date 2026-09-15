// Verifica la INTEGRIDAD ESTRUCTURAL de la biblioteca de defectos (pieza
// (B) del motor RM — analysis/conformationKnowledgeBase.ts). No valida
// juicio veterinario (eso es responsabilidad de Ramon al calibrar), sino
// las invariantes que el resto del motor (severity/scoringEngine/
// rmPriorityRules) da por sentadas — un dato mal formado acá rompe
// silenciosamente el cálculo de CUALQUIER Hip que dispare ese defecto.
import { CONFORMATION_KNOWLEDGE_BASE, findDefect } from "../../src/analysis/conformationKnowledgeBase";

describe("CONFORMATION_KNOWLEDGE_BASE: integridad estructural", () => {
  test("no está vacía", () => {
    expect(CONFORMATION_KNOWLEDGE_BASE.length).toBeGreaterThan(0);
  });

  test("todos los IDs son únicos (un ID duplicado haría que findDefect() siempre devuelva el primero, silenciosamente)", () => {
    const ids = CONFORMATION_KNOWLEDGE_BASE.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(CONFORMATION_KNOWLEDGE_BASE.map((d) => [d.id, d] as const))(
    "%s: bandas de tolerancia son crecientes y no negativas",
    (_id, defect) => {
      const { correctoMax, leveMax, moderadoMax } = defect.tolerance;
      expect(correctoMax).toBeGreaterThanOrEqual(0);
      expect(leveMax).toBeGreaterThan(correctoMax);
      expect(moderadoMax).toBeGreaterThan(leveMax);
    }
  );

  test.each(CONFORMATION_KNOWLEDGE_BASE.map((d) => [d.id, d] as const))(
    "%s: rmWeight está en [0,1]",
    (_id, defect) => {
      expect(defect.rmWeight).toBeGreaterThanOrEqual(0);
      expect(defect.rmWeight).toBeLessThanOrEqual(1);
    }
  );

  test.each(CONFORMATION_KNOWLEDGE_BASE.map((d) => [d.id, d] as const))(
    "%s: relatedDefectIds apuntan a defectos que realmente existen en la base (sin referencias rotas)",
    (_id, defect) => {
      for (const relatedId of defect.relatedDefectIds) {
        expect(findDefect(relatedId)).toBeDefined();
      }
    }
  );

  test.each(CONFORMATION_KNOWLEDGE_BASE.map((d) => [d.id, d] as const))(
    "%s: view es uno de los 3 valores válidos",
    (_id, defect) => {
      expect(["frontal", "lateral", "posterior"]).toContain(defect.view);
    }
  );

  test("los 9 criterios prioritarios RM (rmPriority:true) llevan el peso más alto en promedio que los internos", () => {
    const priority = CONFORMATION_KNOWLEDGE_BASE.filter((d) => d.rmPriority);
    const internal = CONFORMATION_KNOWLEDGE_BASE.filter((d) => !d.rmPriority);
    expect(priority.length).toBeGreaterThan(0);
    if (internal.length === 0) return; // toda la KB podría ser rmPriority en el futuro
    const avg = (arr: typeof priority) => arr.reduce((s, d) => s + d.rmWeight, 0) / arr.length;
    expect(avg(priority)).toBeGreaterThanOrEqual(avg(internal));
  });
});
