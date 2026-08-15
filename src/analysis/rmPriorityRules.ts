// RM Priority Rules — pieza (D) del motor. Traduce los criterios F1–F3 /
// L1–L4 / P1–P2 en mediciones geométricas ejecutables sobre landmarks ya
// extraídos, distinguiendo correctamente terminología según DÓNDE empieza
// la desviación anatómica (punto 1 y secciones F1/F2/L4 de las
// instrucciones) — nunca un único término genérico para todo.
//
// Cada "familia" mutuamente excluyente (ver doubleCountingRule en
// conformationKnowledgeBase.ts) se resuelve ACÁ: se calculan todos los
// candidatos de la familia y se emite solo el dominante (mayor magnitud),
// exactamente el mecanismo anti doble-penalización del punto 10.

import { LandmarkPoint, Side, ViewLandmarks } from "./landmarks";
import {
  angleFromGroundPlane,
  angleFromVertical,
  combinedConfidence,
  distance,
  jointAngle,
  signedPerpendicularOffset,
  toVec,
} from "./geometry";
import { classifySeverity } from "./severity";
import { findDefect } from "./conformationKnowledgeBase";
import { Finding } from "./findings";

/**
 * Mapa de "valores crudos que mide el propio caballo referente en cada
 * métrica", independiente de qué defectId terminó ganando en el
 * referente (ver nota larga más abajo, y corrección de Ramon 2026-08-14
 * sobre integración del referente). Las claves son los mismos strings
 * que usan las funciones evaluate*Findings acá abajo — ver comentarios
 * "clave de métrica" en cada bloque.
 */
export type ReferenceMetrics = Record<string, number>;

export interface ViewEvaluation {
  findings: Finding[];
  /** Valores crudos de cada métrica calculada, se hayan reportado o no como Finding — es lo que se guarda como ReferenceMetrics cuando esta función corre sobre las fotos del caballo referente (ver referenceCalibration.ts). */
  rawMetrics: ReferenceMetrics;
}

function get<M extends Record<string, LandmarkPoint | undefined>>(map: M, id: keyof M): LandmarkPoint | undefined {
  const p = map[id];
  return p && p.visible ? p : undefined;
}

function buildFinding(
  defectId: string,
  side: Side | undefined,
  measuredValue: number,
  absDeviation: number,
  confidence: number,
  referenceValue?: number | null
): Finding {
  const defect = findDefect(defectId);
  if (!defect) throw new Error(`Defecto desconocido en la biblioteca: ${defectId}`);
  const { severity, magnitude01 } = classifySeverity(measuredValue, defect.tolerance, referenceValue);
  return { defectId, view: defect.view, side, measuredValue, absDeviation, severity, magnitude01, confidence };
}

/** +1 si un offset hacia +x cuenta como MEDIAL para este lado, -1 si cuenta como LATERAL. Ver nota de convención de ejes en el comentario largo más abajo. */
function medialSign(side: Side): 1 | -1 {
  // El lado IZQUIERDO del caballo aparece del lado DERECHO de la foto
  // cuando mira de frente a la cámara — así que para la pata izquierda,
  // "medial" (hacia la línea media) es hacia -x (izquierda de la
  // imagen); para la derecha, medial es hacia +x.
  return side === "left" ? -1 : 1;
}

// ============================================================
// FRONTAL — F1 (medial) / F2 (lateral) / F3 (asimetría de cascos).
// ============================================================
export function evaluateFrontalFindings(
  lm: ViewLandmarks<"frontal">,
  viewConfidence: number,
  referenceMetrics?: ReferenceMetrics
): ViewEvaluation {
  const findings: Finding[] = [];
  const rawMetrics: ReferenceMetrics = {};
  const ref = (key: string): number | undefined => referenceMetrics?.[key];
  const chest = get(lm, "chestCenter");
  const shoulderL = get(lm, "shoulderLeft");
  const shoulderR = get(lm, "shoulderRight");
  const hoofL = get(lm, "hoofCenterLeft");
  const hoofR = get(lm, "hoofCenterRight");
  const carpusLBase = get(lm, "carpusLeft");
  const carpusRBase = get(lm, "carpusRight");
  const fetlockLBase = get(lm, "fetlockLeft");
  const fetlockRBase = get(lm, "fetlockRight");

  // --- base_narrow / base_wide (bilateral, un solo hallazgo para las 2 patas) ---
  //
  // CORRECCIÓN DE ESTABILIDAD (2026-08-14, pedida por Ramon tras ver que
  // la MISMA foto frontal podía leerse "base ancha" en una corrida y
  // "base estrecha" en otra): la prueba de 10 corridas mostró que el
  // ancho entre HOMBROS solo (2 puntos) es sensible al ruido normal de
  // ubicación de landmarks entre llamadas — un desplazamiento de pocos
  // pixeles en shoulderLeft/Right cambia el denominador entero del ratio.
  // Esto NO es un problema del estándar anatómico (las bandas de
  // tolerancia de base_narrow/base_wide en conformationKnowledgeBase.ts
  // no se tocaron) sino de qué tan robusta es la REFERENCIA "arriba" que
  // se usa para comparar contra el ancho de apoyo (cascos).
  //
  // Fix: promediar el ancho de hombros con el ancho de carpo y de
  // menudillo (mismos landmarks que YA se extraen para carpus_valgus/
  // varus y toe_in/out en este mismo llamado — no agrega ningún landmark
  // ni llamada nueva) para obtener una referencia proximal menos volátil.
  // Sigue siendo exactamente la misma comparación anatómica ("¿el caballo
  // se abre o se cierra desde el nacimiento de la extremidad hasta el
  // casco?"), solo que promediada sobre 2-3 alturas del miembro en vez de
  // depender de un único par de puntos. Si carpo/menudillo no están
  // visibles, cae de vuelta al comportamiento anterior (solo hombros).
  if (shoulderL && shoulderR && hoofL && hoofR) {
    const shoulderWidth = distance(toVec(shoulderL), toVec(shoulderR));
    const hoofWidth = distance(toVec(hoofL), toVec(hoofR));
    const proximalWidths: number[] = [shoulderWidth];
    const proximalPoints: LandmarkPoint[] = [shoulderL, shoulderR];
    if (carpusLBase && carpusRBase) {
      proximalWidths.push(distance(toVec(carpusLBase), toVec(carpusRBase)));
      proximalPoints.push(carpusLBase, carpusRBase);
    }
    if (fetlockLBase && fetlockRBase) {
      proximalWidths.push(distance(toVec(fetlockLBase), toVec(fetlockRBase)));
      proximalPoints.push(fetlockLBase, fetlockRBase);
    }
    const proximalWidth = proximalWidths.reduce((a, b) => a + b, 0) / proximalWidths.length;
    if (proximalWidth > 0) {
      const ratio = (hoofWidth - proximalWidth) / proximalWidth; // negativo = más angosto abajo (base-narrow), positivo = base-wide
      rawMetrics.baseWidthRatio = ratio;
      const conf = combinedConfidence([...proximalPoints, hoofL, hoofR]);
      const defectId = ratio < 0 ? "base_narrow" : "base_wide";
      findings.push(buildFinding(defectId, undefined, ratio, Math.abs(ratio), conf, ref("baseWidthRatio")));
    }
  }

  // --- Por pata: carpus_valgus/varus, toe_in/toe_out — dominante entre las 3 familias de esa pata ---
  for (const side of ["left", "right"] as const) {
    const shoulder = side === "left" ? shoulderL : shoulderR;
    const hoof = side === "left" ? hoofL : hoofR;
    const carpus = get(lm, side === "left" ? "carpusLeft" : "carpusRight");
    const fetlock = get(lm, side === "left" ? "fetlockLeft" : "fetlockRight");
    const hoofToe = get(lm, side === "left" ? "hoofToeLeft" : "hoofToeRight");
    const sign = medialSign(side);

    type Candidate = { defectId: string; measured: number; absDev: number; conf: number; metricKey: string };
    const candidates: Candidate[] = [];

    // Origen 1: pecho→carpo (carpus_valgus/varus) — offset del carpo respecto a la línea hombro→casco de SU PROPIA pata.
    const carpusOffsetKey = `carpusOffset.${side}`;
    if (shoulder && hoof && carpus) {
      const legLength = distance(toVec(shoulder), toVec(hoof));
      if (legLength > 0) {
        const rawOffset = signedPerpendicularOffset(toVec(carpus), toVec(shoulder), toVec(hoof));
        const normalized = rawOffset / legLength;
        const medialComponent = normalized * sign; // positivo = medial, negativo = lateral
        rawMetrics[carpusOffsetKey] = medialComponent;
        const conf = combinedConfidence([shoulder, hoof, carpus]);
        candidates.push({
          defectId: medialComponent >= 0 ? "carpus_valgus" : "carpus_varus",
          measured: medialComponent,
          absDev: Math.abs(medialComponent),
          conf,
          metricKey: carpusOffsetKey,
        });
      }
    }

    // Origen 2: menudillo→casco (toe_in/toe_out) — rotación del casco respecto a la vertical que baja del menudillo.
    const hoofRotationKey = `hoofRotation.${side}`;
    if (fetlock && hoofToe) {
      const angle = angleFromVertical(toVec(fetlock), toVec(hoofToe)); // grados, + = hacia +x
      const medialAngle = angle * sign; // positivo = rotación medial
      rawMetrics[hoofRotationKey] = medialAngle;
      const conf = combinedConfidence([fetlock, hoofToe]);
      candidates.push({
        defectId: medialAngle >= 0 ? "toe_in" : "toe_out",
        measured: medialAngle,
        absDev: Math.abs(medialAngle),
        conf,
        metricKey: hoofRotationKey,
      });
    }

    if (candidates.length > 0) {
      // Dominante = mayor desviación relativa a SU PROPIA tolerancia
      // profesional (no en unidades crudas, porque una está en "ratio" y
      // la otra en "grados"). La elección del origen dominante es SIEMPRE
      // 100% anatómica/profesional — el referente nunca participa acá,
      // solo puede afinar la magnitud DESPUÉS de que ya se decidió cuál
      // defecto (si alguno) se reporta.
      let best: { c: Candidate; magnitude01: number } | null = null;
      for (const c of candidates) {
        const defect = findDefect(c.defectId)!;
        const { magnitude01 } = classifySeverity(c.measured, defect.tolerance);
        if (!best || magnitude01 > best.magnitude01) best = { c, magnitude01 };
      }
      if (best) {
        findings.push(
          buildFinding(best.c.defectId, side, best.c.measured, best.c.absDev, best.c.conf, ref(best.c.metricKey))
        );
      }
    }
  }

  // --- F3: hoof_asymmetry (bilateral) ---
  const hoofMedialL = get(lm, "hoofMedialLeft");
  const hoofLateralL = get(lm, "hoofLateralLeft");
  const hoofMedialR = get(lm, "hoofMedialRight");
  const hoofLateralR = get(lm, "hoofLateralRight");
  if (hoofMedialL && hoofLateralL && hoofMedialR && hoofLateralR) {
    const widthL = distance(toVec(hoofMedialL), toVec(hoofLateralL));
    const widthR = distance(toVec(hoofMedialR), toVec(hoofLateralR));
    const avg = (widthL + widthR) / 2;
    if (avg > 0) {
      const ratio = Math.abs(widthL - widthR) / avg;
      rawMetrics.hoofAsymmetryRatio = ratio;
      const conf = combinedConfidence([hoofMedialL, hoofLateralL, hoofMedialR, hoofLateralR]);
      findings.push(buildFinding("hoof_asymmetry", undefined, ratio, ratio, conf, ref("hoofAsymmetryRatio")));
    }
  }

  return { findings, rawMetrics };
}

// ============================================================
// LATERAL — L1 (over at the knee) / L2 (vertical) / L3 (cuartilla) /
// L4 (alineación posterior).
// ============================================================
export function evaluateLateralFindings(
  lm: ViewLandmarks<"lateral">,
  viewConfidence: number,
  referenceMetrics?: ReferenceMetrics
): ViewEvaluation {
  const findings: Finding[] = [];
  const rawMetrics: ReferenceMetrics = {};
  const ref = (key: string): number | undefined => referenceMetrics?.[key];

  // --- L1: over_at_the_knee / calf_kneed ---
  const elbow = get(lm, "elbow");
  const carpus = get(lm, "carpus");
  const fetlockFront = get(lm, "fetlockFront");
  if (elbow && carpus && fetlockFront) {
    const legLength = distance(toVec(elbow), toVec(fetlockFront));
    if (legLength > 0) {
      const rawOffset = signedPerpendicularOffset(toVec(carpus), toVec(elbow), toVec(fetlockFront));
      const normalized = rawOffset / legLength; // convención: positivo = craneal (adelante), ver nota abajo
      rawMetrics.kneeOffset = normalized;
      const conf = combinedConfidence([elbow, carpus, fetlockFront]);
      const defectId = normalized >= 0 ? "over_at_the_knee" : "calf_kneed";
      findings.push(buildFinding(defectId, undefined, normalized, Math.abs(normalized), conf, ref("kneeOffset")));
    }
  }

  // --- L2/L3: ángulo cuartilla anterior (upright vs long/sloping) ---
  const coronetFront = get(lm, "coronetFront");
  const hoofToeFront = get(lm, "hoofToeFront");
  const hoofHeelFront = get(lm, "hoofHeelFront");
  if (coronetFront && hoofHeelFront) {
    // Ángulo de la cuartilla respecto al PLANO DEL SUELO. BUG REAL
    // corregido acá (2026-08-14, encontrado en la prueba controlada de
    // reproducibilidad de esa fecha): el cálculo anterior usaba
    // `90 - Math.abs(angleFromVertical(heel, coronet))`, pero
    // `angleFromVertical` mide el ángulo respecto a "derecho hacia
    // ABAJO" — como talón→banda coronaria siempre apunta hacia ARRIBA en
    // la imagen, ese valor cae SIEMPRE en el rango [90°,180°] para
    // cualquier cuartilla físicamente posible, y la resta daba SIEMPRE un
    // número negativo (ej. una cuartilla perfectamente vertical de 90°
    // reales daba -90, no +90). El resultado: este hallazgo salía
    // "marcado" al tope (magnitude01=1) en el 100% de las corridas de la
    // prueba, sin importar la cuartilla real — no era ruido de landmarks,
    // era la fórmula. `angleFromGroundPlane` (geometry.ts) mide
    // directamente el ángulo con el suelo sin ese problema de signo.
    const angleFromGround = angleFromGroundPlane(toVec(hoofHeelFront), toVec(coronetFront));
    // Rango correcto profesional: 45°–50° (ver Kentucky Equine Research,
    // hoof-pastern axis). Centro de referencia: 47.5°.
    const idealCenter = 47.5;
    const deviation = angleFromGround - idealCenter; // positivo = más vertical de lo ideal (upright), negativo = más inclinado (sloping)
    rawMetrics.pasternAngleDeviation = deviation;
    const conf = combinedConfidence([coronetFront, hoofHeelFront]);
    const defectId = deviation >= 0 ? "upright_pastern" : "long_sloping_pastern";
    findings.push(buildFinding(defectId, undefined, deviation, Math.abs(deviation), conf, ref("pasternAngleDeviation")));
  }

  // --- L2 (catch-all): verticalidad de toda la extremidad ---
  const cannonMidFront = get(lm, "cannonMidFront");
  if (carpus && cannonMidFront && fetlockFront) {
    const angle = angleFromVertical(toVec(carpus), toVec(fetlockFront));
    rawMetrics.legVerticality = angle;
    const conf = combinedConfidence([carpus, cannonMidFront, fetlockFront]);
    findings.push(buildFinding("excessively_vertical_leg", undefined, angle, Math.abs(angle), conf, ref("legVerticality")));
  }

  // --- L4: familia posterior (sickle-hocked / post-legged / camped-under / camped-out) ---
  const buttock = get(lm, "pointOfButtock");
  const hock = get(lm, "hock");
  const stifle = get(lm, "stifle");
  const fetlockHind = get(lm, "fetlockHind");
  const hoofHeelHind = get(lm, "hoofHeelHind");
  if (buttock && hoofHeelHind && hock) {
    const legLength = distance(toVec(buttock), toVec(hoofHeelHind));
    type Candidate = { defectId: string; measured: number; absDev: number; conf: number; metricKey: string };
    const candidates: Candidate[] = [];

    if (legLength > 0) {
      // Offset de TODA la pierna (a la altura del corvejón) respecto a la plomada punta-de-nalga→talón.
      const legOffset = signedPerpendicularOffset(toVec(hock), toVec(buttock), toVec(hoofHeelHind)) / legLength;
      rawMetrics.hindLegOffset = legOffset;
      const legConf = combinedConfidence([buttock, hoofHeelHind, hock]);
      candidates.push({
        defectId: legOffset >= 0 ? "camped_under" : "camped_out",
        measured: legOffset,
        absDev: Math.abs(legOffset),
        conf: legConf,
        metricKey: "hindLegOffset",
      });
    }

    if (stifle && fetlockHind) {
      // Ángulo del corvejón: vértice=hock, brazos hacia stifle y hacia fetlockHind. Un corvejón "de hoz" tiene un ángulo marcadamente MENOR a 180° (muy doblado); post-legged tiene un ángulo cercano a 180° (casi recto).
      const angle = jointAngle(toVec(hock), toVec(stifle), toVec(fetlockHind));
      const idealAngle = 155; // referencia profesional aproximada de ángulo de corvejón funcional
      const deviation = idealAngle - angle; // positivo = ángulo menor a lo ideal (más doblado = sickle-hocked); negativo = más recto (post-legged)
      rawMetrics.hockAngleDeviation = deviation;
      const conf = combinedConfidence([hock, stifle, fetlockHind]);
      candidates.push({
        defectId: deviation >= 0 ? "sickle_hocked" : "post_legged",
        measured: deviation,
        absDev: Math.abs(deviation),
        conf,
        metricKey: "hockAngleDeviation",
      });
    }

    if (candidates.length > 0) {
      let best: { c: Candidate; magnitude01: number } | null = null;
      for (const c of candidates) {
        const defect = findDefect(c.defectId)!;
        const { magnitude01 } = classifySeverity(c.measured, defect.tolerance);
        if (!best || magnitude01 > best.magnitude01) best = { c, magnitude01 };
      }
      if (best) {
        findings.push(
          buildFinding(best.c.defectId, undefined, best.c.measured, best.c.absDev, best.c.conf, ref(best.c.metricKey))
        );
      }
    }
  }

  return { findings, rawMetrics };
}

// ============================================================
// POSTERIOR — P1 (cow-hocked) / P2 (bow-hocked).
// ============================================================
export function evaluatePosteriorFindings(
  lm: ViewLandmarks<"posterior">,
  viewConfidence: number,
  referenceMetrics?: ReferenceMetrics
): ViewEvaluation {
  const findings: Finding[] = [];
  const rawMetrics: ReferenceMetrics = {};
  const ref = (key: string): number | undefined => referenceMetrics?.[key];
  const coxaeL = get(lm, "tuberCoxaeLeft");
  const coxaeR = get(lm, "tuberCoxaeRight");
  const hockL = get(lm, "hockLeft");
  const hockR = get(lm, "hockRight");
  const hoofL = get(lm, "hoofCenterLeft");
  const hoofR = get(lm, "hoofCenterRight");

  if (coxaeL && coxaeR && hockL && hockR && hoofL && hoofR) {
    const pelvisWidth = distance(toVec(coxaeL), toVec(coxaeR));
    const hockWidth = distance(toVec(hockL), toVec(hockR));
    const hoofWidth = distance(toVec(hoofL), toVec(hoofR));
    if (pelvisWidth > 0) {
      // cow-hocked: corvejones más angostos que cadera Y que cascos.
      // bow-hocked: corvejones más anchos que cadera Y que cascos.
      const hockVsPelvis = (hockWidth - pelvisWidth) / pelvisWidth;
      const hockVsHoof = pelvisWidth > 0 ? (hockWidth - hoofWidth) / pelvisWidth : 0;
      // Patrón compuesto: promedio de ambas comparaciones (corvejón
      // respecto a cadera, y corvejón respecto a casco) — un valor
      // negativo consistente en ambas es cow-hocked, positivo consistente
      // es bow-hocked. Si las 2 comparaciones no coinciden en signo, el
      // patrón es ambiguo y se pondera hacia 0 (menos confianza en el
      // patrón, no en los landmarks individuales).
      const composite = (hockVsPelvis + hockVsHoof) / 2;
      rawMetrics.hockWidthComposite = composite;
      const conf = combinedConfidence([coxaeL, coxaeR, hockL, hockR, hoofL, hoofR]);
      const defectId = composite < 0 ? "cow_hocked" : "bow_hocked";
      findings.push(buildFinding(defectId, undefined, composite, Math.abs(composite), conf, ref("hockWidthComposite")));
    }
  }

  return { findings, rawMetrics };
}
