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

function get<M extends Record<string, LandmarkPoint | undefined>>(map: M, id: keyof M): LandmarkPoint | undefined {
  const p = map[id];
  return p && p.visible ? p : undefined;
}

function buildFinding(defectId: string, side: Side | undefined, measuredValue: number, absDeviation: number, confidence: number): Finding {
  const defect = findDefect(defectId);
  if (!defect) throw new Error(`Defecto desconocido en la biblioteca: ${defectId}`);
  const { severity, magnitude01 } = classifySeverity(absDeviation, defect.tolerance);
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
export function evaluateFrontalFindings(lm: ViewLandmarks<"frontal">, viewConfidence: number): Finding[] {
  const findings: Finding[] = [];
  const chest = get(lm, "chestCenter");
  const shoulderL = get(lm, "shoulderLeft");
  const shoulderR = get(lm, "shoulderRight");
  const hoofL = get(lm, "hoofCenterLeft");
  const hoofR = get(lm, "hoofCenterRight");

  // --- base_narrow / base_wide (bilateral, un solo hallazgo para las 2 patas) ---
  if (shoulderL && shoulderR && hoofL && hoofR) {
    const shoulderWidth = distance(toVec(shoulderL), toVec(shoulderR));
    const hoofWidth = distance(toVec(hoofL), toVec(hoofR));
    if (shoulderWidth > 0) {
      const ratio = (hoofWidth - shoulderWidth) / shoulderWidth; // negativo = más angosto abajo (base-narrow), positivo = base-wide
      const conf = combinedConfidence([shoulderL, shoulderR, hoofL, hoofR]);
      const defectId = ratio < 0 ? "base_narrow" : "base_wide";
      findings.push(buildFinding(defectId, undefined, ratio, Math.abs(ratio), conf));
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

    type Candidate = { defectId: string; measured: number; absDev: number; conf: number };
    const candidates: Candidate[] = [];

    // Origen 1: pecho→carpo (carpus_valgus/varus) — offset del carpo respecto a la línea hombro→casco de SU PROPIA pata.
    if (shoulder && hoof && carpus) {
      const legLength = distance(toVec(shoulder), toVec(hoof));
      if (legLength > 0) {
        const rawOffset = signedPerpendicularOffset(toVec(carpus), toVec(shoulder), toVec(hoof));
        const normalized = rawOffset / legLength;
        const medialComponent = normalized * sign; // positivo = medial, negativo = lateral
        const conf = combinedConfidence([shoulder, hoof, carpus]);
        candidates.push({
          defectId: medialComponent >= 0 ? "carpus_valgus" : "carpus_varus",
          measured: medialComponent,
          absDev: Math.abs(medialComponent),
          conf,
        });
      }
    }

    // Origen 2: menudillo→casco (toe_in/toe_out) — rotación del casco respecto a la vertical que baja del menudillo.
    if (fetlock && hoofToe) {
      const angle = angleFromVertical(toVec(fetlock), toVec(hoofToe)); // grados, + = hacia +x
      const medialAngle = angle * sign; // positivo = rotación medial
      const conf = combinedConfidence([fetlock, hoofToe]);
      candidates.push({
        defectId: medialAngle >= 0 ? "toe_in" : "toe_out",
        measured: medialAngle,
        absDev: Math.abs(medialAngle),
        conf,
      });
    }

    if (candidates.length > 0) {
      // Dominante = mayor desviación relativa a SU PROPIA tolerancia (no
      // en unidades crudas, porque una está en "ratio" y la otra en
      // "grados" — comparables recién después de pasar por severity).
      let best: { c: Candidate; magnitude01: number } | null = null;
      for (const c of candidates) {
        const defect = findDefect(c.defectId)!;
        const { magnitude01 } = classifySeverity(c.absDev, defect.tolerance);
        if (!best || magnitude01 > best.magnitude01) best = { c, magnitude01 };
      }
      if (best) findings.push(buildFinding(best.c.defectId, side, best.c.measured, best.c.absDev, best.c.conf));
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
      const conf = combinedConfidence([hoofMedialL, hoofLateralL, hoofMedialR, hoofLateralR]);
      findings.push(buildFinding("hoof_asymmetry", undefined, ratio, ratio, conf));
    }
  }

  return findings;
}

// ============================================================
// LATERAL — L1 (over at the knee) / L2 (vertical) / L3 (cuartilla) /
// L4 (alineación posterior).
// ============================================================
export function evaluateLateralFindings(lm: ViewLandmarks<"lateral">, viewConfidence: number): Finding[] {
  const findings: Finding[] = [];

  // --- L1: over_at_the_knee / calf_kneed ---
  const elbow = get(lm, "elbow");
  const carpus = get(lm, "carpus");
  const fetlockFront = get(lm, "fetlockFront");
  if (elbow && carpus && fetlockFront) {
    const legLength = distance(toVec(elbow), toVec(fetlockFront));
    if (legLength > 0) {
      const rawOffset = signedPerpendicularOffset(toVec(carpus), toVec(elbow), toVec(fetlockFront));
      const normalized = rawOffset / legLength; // convención: positivo = craneal (adelante), ver nota abajo
      const conf = combinedConfidence([elbow, carpus, fetlockFront]);
      const defectId = normalized >= 0 ? "over_at_the_knee" : "calf_kneed";
      findings.push(buildFinding(defectId, undefined, normalized, Math.abs(normalized), conf));
    }
  }

  // --- L2/L3: ángulo cuartilla anterior (upright vs long/sloping) ---
  const coronetFront = get(lm, "coronetFront");
  const hoofToeFront = get(lm, "hoofToeFront");
  const hoofHeelFront = get(lm, "hoofHeelFront");
  if (coronetFront && hoofHeelFront) {
    // Ángulo de la pared del casco/cuartilla respecto al suelo (aprox.
    // con la vertical de la foto — 90° - angleFromVertical da el ángulo
    // respecto a la horizontal/suelo).
    const angleFromVert = angleFromVertical(toVec(hoofHeelFront), toVec(coronetFront));
    const angleFromGround = 90 - Math.abs(angleFromVert);
    // Rango correcto profesional: 45°–50° (ver Kentucky Equine Research,
    // hoof-pastern axis). Centro de referencia: 47.5°.
    const idealCenter = 47.5;
    const deviation = angleFromGround - idealCenter; // positivo = más vertical de lo ideal (upright), negativo = más inclinado (sloping)
    const conf = combinedConfidence([coronetFront, hoofHeelFront]);
    const defectId = deviation >= 0 ? "upright_pastern" : "long_sloping_pastern";
    findings.push(buildFinding(defectId, undefined, deviation, Math.abs(deviation), conf));
  }

  // --- L2 (catch-all): verticalidad de toda la extremidad ---
  const cannonMidFront = get(lm, "cannonMidFront");
  if (carpus && cannonMidFront && fetlockFront) {
    const angle = angleFromVertical(toVec(carpus), toVec(fetlockFront));
    const conf = combinedConfidence([carpus, cannonMidFront, fetlockFront]);
    findings.push(buildFinding("excessively_vertical_leg", undefined, angle, Math.abs(angle), conf));
  }

  // --- L4: familia posterior (sickle-hocked / post-legged / camped-under / camped-out) ---
  const buttock = get(lm, "pointOfButtock");
  const hock = get(lm, "hock");
  const stifle = get(lm, "stifle");
  const fetlockHind = get(lm, "fetlockHind");
  const hoofHeelHind = get(lm, "hoofHeelHind");
  if (buttock && hoofHeelHind && hock) {
    const legLength = distance(toVec(buttock), toVec(hoofHeelHind));
    type Candidate = { defectId: string; measured: number; absDev: number; conf: number };
    const candidates: Candidate[] = [];

    if (legLength > 0) {
      // Offset de TODA la pierna (a la altura del corvejón) respecto a la plomada punta-de-nalga→talón.
      const legOffset = signedPerpendicularOffset(toVec(hock), toVec(buttock), toVec(hoofHeelHind)) / legLength;
      const legConf = combinedConfidence([buttock, hoofHeelHind, hock]);
      candidates.push({
        defectId: legOffset >= 0 ? "camped_under" : "camped_out",
        measured: legOffset,
        absDev: Math.abs(legOffset),
        conf: legConf,
      });
    }

    if (stifle && fetlockHind) {
      // Ángulo del corvejón: vértice=hock, brazos hacia stifle y hacia fetlockHind. Un corvejón "de hoz" tiene un ángulo marcadamente MENOR a 180° (muy doblado); post-legged tiene un ángulo cercano a 180° (casi recto).
      const angle = jointAngle(toVec(hock), toVec(stifle), toVec(fetlockHind));
      const idealAngle = 155; // referencia profesional aproximada de ángulo de corvejón funcional
      const deviation = idealAngle - angle; // positivo = ángulo menor a lo ideal (más doblado = sickle-hocked); negativo = más recto (post-legged)
      const conf = combinedConfidence([hock, stifle, fetlockHind]);
      candidates.push({
        defectId: deviation >= 0 ? "sickle_hocked" : "post_legged",
        measured: deviation,
        absDev: Math.abs(deviation),
        conf,
      });
    }

    if (candidates.length > 0) {
      let best: { c: Candidate; magnitude01: number } | null = null;
      for (const c of candidates) {
        const defect = findDefect(c.defectId)!;
        const { magnitude01 } = classifySeverity(c.absDev, defect.tolerance);
        if (!best || magnitude01 > best.magnitude01) best = { c, magnitude01 };
      }
      if (best) findings.push(buildFinding(best.c.defectId, undefined, best.c.measured, best.c.absDev, best.c.conf));
    }
  }

  return findings;
}

// ============================================================
// POSTERIOR — P1 (cow-hocked) / P2 (bow-hocked).
// ============================================================
export function evaluatePosteriorFindings(lm: ViewLandmarks<"posterior">, viewConfidence: number): Finding[] {
  const findings: Finding[] = [];
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
      const conf = combinedConfidence([coxaeL, coxaeR, hockL, hockR, hoofL, hoofR]);
      const defectId = composite < 0 ? "cow_hocked" : "bow_hocked";
      findings.push(buildFinding(defectId, undefined, composite, Math.abs(composite), conf));
    }
  }

  return findings;
}
