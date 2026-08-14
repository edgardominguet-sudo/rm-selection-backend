// Findings Prioritizer — pieza (G) del motor RM.
//
// "El motor analiza mucho y muestra poco" (punto 13 de las
// instrucciones): acá se decide, de todos los hallazgos calculados para
// una vista, cuáles — si alguno — llegan a mostrarse. La desambiguación
// entre defectos de la misma familia (toe-in vs base-narrow, sickle-
// hocked vs post-legged, etc.) ya la resolvió rmPriorityRules.ts emitiendo
// UN solo candidato dominante por familia; acá solo queda ordenar por
// prioridad RM y quedarse con los más importantes.

import { ConformationDefect, findDefect } from "./conformationKnowledgeBase";
import { Finding } from "./findings";
import { MIN_ACTIONABLE_CONFIDENCE } from "./severity";

interface Candidate {
  finding: Finding;
  defect: ConformationDefect;
}

export interface DisplayFinding {
  defectId: string;
  labelEn: string;
  labelEs: string;
  severity: "leve" | "moderado" | "marcado";
}

/**
 * Devuelve, como máximo, `maxDisplay` hallazgos para mostrar en pantalla
 * — ordenados por importancia real (peso RM × severidad × confianza), NO
 * por orden de cálculo. Array vacío significa "✓ Correct": no hay ningún
 * hallazgo prioritario con severidad y confianza suficientes para
 * mostrarse.
 */
export function prioritizeFindings(findings: Finding[], maxDisplay = 2): DisplayFinding[] {
  const candidates: Candidate[] = findings
    .filter((f) => f.severity !== "correct" && f.confidence >= MIN_ACTIONABLE_CONFIDENCE)
    .map((f) => {
      const defect = findDefect(f.defectId);
      return defect && defect.rmPriority ? { finding: f, defect } : null;
    })
    .filter((x): x is Candidate => x !== null);

  candidates.sort((a, b) => {
    const scoreA = a.defect.rmWeight * a.finding.magnitude01 * a.finding.confidence;
    const scoreB = b.defect.rmWeight * b.finding.magnitude01 * b.finding.confidence;
    return scoreB - scoreA;
  });

  return candidates.slice(0, maxDisplay).map(({ finding, defect }) => ({
    defectId: finding.defectId,
    labelEn: defect.nameEn,
    labelEs: defect.nameEs,
    severity: finding.severity as "leve" | "moderado" | "marcado",
  }));
}
