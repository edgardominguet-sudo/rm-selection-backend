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
 * Clasifica una DESVIACIÓN FIRMADA (misma unidad que `tolerance.unit`, ya
 * sea grados, offset normalizado o ratio; 0 = eje/ángulo anatómico ideal)
 * contra las bandas profesionales del defecto.
 *
 * `referenceValue` (opcional, 2026-08-14 — corrección de Ramon sobre cómo
 * debe participar el caballo referente): el valor que el propio caballo
 * referente mide en esta misma métrica, en las mismas unidades. Cuando se
 * provee, y SOLO SI la medición ya cae dentro de la banda "Correct" (es
 * decir, ya es anatómicamente segura según el estándar profesional), se
 * usa para afinar qué tan cerca del PATRÓN ESTRUCTURAL RM está el
 * caballo evaluado, dentro de esa misma banda seguridad. El valor de
 * referencia SIEMPRE se recorta (clamp) a los límites de la banda
 * "Correct" antes de usarse — así el referente nunca puede convertir una
 * desviación real (leve/moderado/marcado) en "correcto", ni desplazar el
 * límite de seguridad anatómica hacia afuera. Fuera de la banda "Correct"
 * el referente NO participa en absoluto: severidad y etiqueta del
 * defecto siguen gobernadas 100% por el estándar profesional.
 *
 * Resumen (ver corrección de Ramon, 2026-08-14):
 *   ESTÁNDAR PROFESIONAL = define qué es anatomía correcta y protege
 *     contra errores (bandas leve/moderado/marcado, sin tocar).
 *   CABALLO REFERENTE = calibra, DENTRO de esa anatomía correcta, el
 *     patrón estructural que valora el Método RM (afina el 0.00–0.15 de
 *     magnitud dentro de la banda "Correct", nunca más allá).
 */
export function classifySeverity(
  measuredValue: number,
  tolerance: ToleranceBands,
  referenceValue?: number | null
): SeverityResult {
  const absDeviation = Math.abs(measuredValue);
  const { correctoMax, leveMax, moderadoMax } = tolerance;
  if (absDeviation <= correctoMax) {
    // Dentro de la zona segura profesional. Si tenemos el valor que mide
    // el propio referente en esta métrica, usamos la distancia al PATRÓN
    // RM (recortado para no salirse nunca de esta misma banda) en vez de
    // la distancia al 0 abstracto — así "igual al referente" tiende a
    // magnitude01→0 (más cerca de 10) y "anatómicamente correcto pero
    // distinto del patrón RM" sigue en el rango 0–0.15 (nunca cruza a
    // "leve"). Sin referenceValue, se comporta exactamente igual que
    // antes (distancia al 0 = ideal anatómico abstracto).
    let effectiveDeviation = absDeviation;
    if (referenceValue !== undefined && referenceValue !== null && Number.isFinite(referenceValue) && correctoMax > 0) {
      const clampedTarget = Math.max(-correctoMax, Math.min(correctoMax, referenceValue));
      effectiveDeviation = Math.abs(measuredValue - clampedTarget);
    }
    const magnitude01 = correctoMax > 0 ? Math.min(1, effectiveDeviation / correctoMax) * 0.15 : 0;
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
