// Sistema de Severidad + Confianza — pieza (E) del motor RM.
//
// Severidad: SIEMPRE derivada de la magnitud de la desviación medida,
// normalizada contra las bandas de tolerancia del defecto (ver
// conformationKnowledgeBase.ts) — nunca una descripción subjetiva elegida
// por un modelo generativo (punto 8 de las instrucciones).
//
// Confianza: cada hallazgo lleva una puntuación de confianza 0.0–1.0,
// propagada desde la confianza de los landmarks que participaron en su
// medición (ver geometry.ts, combinedConfidence) y ajustada por la
// confianza global de la foto de esa vista. Un hallazgo de baja confianza
// nunca debe pesar en el score como si fuera una medición segura (punto 9).

import { ToleranceBands } from "./conformationKnowledgeBase";

export type Severity = "correct" | "leve" | "moderado" | "marcado";

export interface SeverityResult {
  severity: Severity;
  /** 0.0 (dentro de tolerancia) a 1.0 (desviación máxima considerada) — magnitud normalizada, usada como multiplicador de penalización en el scoring. */
  magnitude01: number;
}

/**
 * Clasifica una magnitud de desviación (YA en las mismas unidades que
 * `tolerance.unit`, ya sea grados, offset normalizado o ratio) contra las
 * bandas configurables del defecto. `absDeviation` debe venir en valor
 * absoluto — la dirección (medial/lateral, craneal/caudal) es un dato
 * aparte del hallazgo, no de la severidad.
 */
export function classifySeverity(absDeviation: number, tolerance: ToleranceBands): SeverityResult {
  const { correctoMax, leveMax, moderadoMax } = tolerance;
  if (absDeviation <= correctoMax) {
    // Dentro de tolerancia: magnitud proporcional a cuánto de ese margen se usó (0 = perfecto, 1 = justo en el límite), solo informativo.
    const magnitude01 = correctoMax > 0 ? Math.min(1, absDeviation / correctoMax) * 0.15 : 0;
    return { severity: "correct", magnitude01 };
  }
  if (absDeviation <= leveMax) {
    const span = leveMax - correctoMax;
    const t = span > 0 ? (absDeviation - correctoMax) / span : 1;
    return { severity: "leve", magnitude01: 0.15 + 0.25 * t }; // 0.15–0.40
  }
  if (absDeviation <= moderadoMax) {
    const span = moderadoMax - leveMax;
    const t = span > 0 ? (absDeviation - leveMax) / span : 1;
    return { severity: "moderado", magnitude01: 0.4 + 0.35 * t }; // 0.40–0.75
  }
  // Marcado: por encima del techo "moderado" — la magnitud sigue creciendo
  // pero se satura en 1.0 a partir de 2x moderadoMax, para que una
  // desviación extrema no rompa el resto del cálculo de score.
  const over = absDeviation - moderadoMax;
  const saturationSpan = Math.max(moderadoMax, 0.0001);
  const t = Math.min(1, over / saturationSpan);
  return { severity: "marcado", magnitude01: 0.75 + 0.25 * t }; // 0.75–1.0
}

/**
 * Confianza final de un hallazgo: combina la confianza geométrica (de los
 * landmarks involucrados, ya calculada por geometry.combinedConfidence)
 * con la confianza global de clasificación/validez de la foto de esa
 * vista. Se usa el MÍNIMO, mismo criterio que combinedConfidence — la
 * cadena es tan fuerte como su eslabón más débil.
 */
export function findingConfidence(landmarkConfidence: number, viewOverallConfidence: number): number {
  return Math.min(landmarkConfidence, viewOverallConfidence);
}

/** Umbral por debajo del cual un hallazgo NO debe penalizar el score ni mostrarse — la limitación de la foto (perspectiva, oclusión, luz) impide medir con seguridad, y el motor debe reconocerlo (punto 9) en vez de inventar certeza. */
export const MIN_ACTIONABLE_CONFIDENCE = 0.55;
