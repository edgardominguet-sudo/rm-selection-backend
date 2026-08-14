// Tipos compartidos de "hallazgo" — la unidad que produce
// rmPriorityRules.ts, consume severity.ts para clasificarse, y que
// scoringEngine.ts / findingsPrioritizer.ts usan para calcular el score y
// elegir qué mostrar.

import { Severity } from "./severity";
import { Side, ViewName } from "./landmarks";

export interface Finding {
  defectId: string;
  view: ViewName;
  /** Lado de la extremidad afectada — undefined para defectos que se miden como patrón bilateral único (cow_hocked/bow_hocked). */
  side?: Side;
  /** Valor medido, en las unidades del `tolerance.unit` del defecto (ver conformationKnowledgeBase.ts). */
  measuredValue: number;
  /** Desviación absoluta respecto al eje esperado, en esas mismas unidades — lo que severity.classifySeverity() clasifica. */
  absDeviation: number;
  severity: Severity;
  /** 0.0–1.0, magnitud normalizada de la desviación — insumo directo del scoring determinístico. */
  magnitude01: number;
  /** 0.0–1.0, confianza de esta medición puntual (ver severity.findingConfidence). */
  confidence: number;
}

export interface ViewFindings {
  view: ViewName;
  /** true si esta vista tuvo al menos una foto válida y clasificada del Hip — si es false, no hay findings reales, y el score de esta vista no debe calcularse (queda en 0, mismo criterio que la metodología anterior: "una fotografía faltante nunca debe recibir 0 puntos" se traduce en NO promediar esta vista como disponible). */
  available: boolean;
  findings: Finding[];
}
