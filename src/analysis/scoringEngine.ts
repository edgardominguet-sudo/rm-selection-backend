// Motor de Scoring determinístico — pieza (F) del motor RM.
//
// Puntaje 0.0–10.0 por vista (FRONT/SIDE/REAR), calculado ÚNICAMENTE a
// partir de las mediciones y pesos internos — nunca "elegido" por un
// modelo generativo (punto 11 de las instrucciones). Dado el mismo
// conjunto de landmarks de entrada, esta función SIEMPRE devuelve el
// mismo número: es una función pura sobre `Finding[]`.

import { findDefect } from "./conformationKnowledgeBase";
import { Finding } from "./findings";
import { MIN_ACTIONABLE_CONFIDENCE } from "./severity";

/** Cuántos puntos, como máximo, puede restar UN hallazgo de severidad "marcado" (magnitude01=1) con confianza plena — escalado por el peso RM del defecto. Calibrado para que 1 defecto marcado en un criterio de peso alto (~0.85-0.9) alcance para sacar al Hip de "EXCELENTE" (8.5) y acercarlo a "REVISAR" (<7.0) si se combina con algún otro hallazgo menor, sin que un solo hallazgo leve hunda el puntaje por sí solo. */
const MAX_PENALTY_PER_FINDING = 3.0;

export interface ViewScore {
  score: number; // 0.0–10.0, redondeado a 1 decimal
  /** Detalle de cuánto restó cada hallazgo priorizado RM al puntaje — para depuración/auditoría, no se muestra al usuario. */
  penalties: Array<{ defectId: string; points: number }>;
}

/**
 * Calcula el puntaje de UNA vista a partir de sus hallazgos. Solo los
 * defectos marcados `rmPriority: true` en la biblioteca penalizan el
 * puntaje — el resto es conocimiento de apoyo interno (desambiguación,
 * ver rmPriorityRules.ts) que no debe mover el número (punto 5 de las
 * instrucciones: los criterios RM son los que "nos importan
 * especialmente como compradores").
 *
 * Hallazgos con confianza por debajo de MIN_ACTIONABLE_CONFIDENCE no
 * penalizan — la limitación de la foto no debe convertirse en un
 * defecto inventado (punto 9).
 */
export function scoreView(findings: Finding[]): ViewScore {
  const penalties: Array<{ defectId: string; points: number }> = [];
  let total = 0;

  for (const f of findings) {
    const defect = findDefect(f.defectId);
    if (!defect || !defect.rmPriority) continue;
    if (f.severity === "correct") continue;
    if (f.confidence < MIN_ACTIONABLE_CONFIDENCE) continue;

    const points = defect.rmWeight * f.magnitude01 * MAX_PENALTY_PER_FINDING * f.confidence;
    penalties.push({ defectId: f.defectId, points });
    total += points;
  }

  const score = Math.max(0, Math.min(10, 10 - total));
  return { score: Math.round(score * 10) / 10, penalties };
}
