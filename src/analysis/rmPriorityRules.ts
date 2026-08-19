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
  angleFromGroundPlaneCorrected,
  angleFromVertical,
  angleFromVerticalCorrected,
  combinedConfidence,
  distance,
  jointAngle,
  postureSquarenessConfidence,
  signedPerpendicularOffset,
  toVec,
} from "./geometry";
import { classifySeverity, findingConfidence } from "./severity";
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

  // CONTROL DE PERSPECTIVA (2026-08-19, pedido de Ramon, prioridad alta):
  // Frontal no tiene línea de suelo propia (a diferencia de Lateral), así
  // que el chequeo geométrico acá es "¿el caballo está parado
  // razonablemente cuadrado hacia la cámara?", usando shoulderLeft/Right
  // (deberían estar a la misma altura real). Si no, se reduce la confianza
  // de TODOS los hallazgos de esta foto — nunca se inventa ni penaliza un
  // defecto que puede ser solo una pata adelantada o cámara rotada (ver
  // geometry.postureSquarenessConfidence).
  const postureConfidence = postureSquarenessConfidence(lm.shoulderLeft, lm.shoulderRight);
  const finalConf = (landmarkConf: number): number => Math.min(findingConfidence(landmarkConf, viewConfidence), postureConfidence);

  // --- base_narrow / base_wide (bilateral, un solo hallazgo para las 2 patas) ---
  //
  // CORRECCIÓN DE ESTABILIDAD, SEGUNDO INTENTO (2026-08-14, pedida por
  // Ramon tras ver que la MISMA foto frontal podía leerse "base ancha" en
  // una corrida y "base estrecha" en otra). PRIMER INTENTO (promediar
  // ancho de hombro+carpo+menudillo) NO funcionó — probado con 10
  // corridas reales: el ratio siguió variando de -0.71 a +0.15 y la
  // clasificación siguió cruzando Excelente/Bien en 4 de 10 corridas. Se
  // descarta y se documenta acá para no repetirlo.
  //
  // Causa raíz real (identificada comparando contra carpus_valgus/varus y
  // toe_in/toe_out EN LA MISMA PRUEBA, que salieron mucho más consistentes
  // entre corridas): comparar un ANCHO ENTRE DOS PATAS (hoofWidth vs.
  // shoulderWidth, cada uno ya calculado a partir de 2 puntos con su
  // propio error de ubicación) resta dos cantidades ya ruidosas y ese
  // ruido se acumula en la diferencia — un error de pocos pixeles en
  // cualquiera de los 4 puntos involucrados mueve el resultado. En
  // cambio, carpus_valgus/varus y toe_in/toe_out miden la desviación de
  // UN punto de SU PROPIA pata respecto a una línea de referencia de esa
  // misma pata (hombro→casco) — un cálculo con menos puntos independientes
  // y normalizado por longitud de pata, que la prueba de reproducibilidad
  // ya mostró que es sensiblemente más estable.
  //
  // Fix real: base_narrow/base_wide se calcula ahora igual que
  // carpus_valgus/varus — el desplazamiento horizontal del CASCO de cada
  // pata respecto a una vertical que baja desde el HOMBRO de esa misma
  // pata (no respecto al casco de la otra pata), normalizado por la
  // longitud hombro→casco de esa pata, promediado entre ambas patas. Es
  // la MISMA definición anatómica (¿el caballo se abre o se cierra desde
  // el nacimiento de la extremidad hasta el casco?) pero medida como el
  // promedio de 2 desviaciones de una sola pata cada una, en vez de la
  // diferencia entre dos anchos de 2 patas. No se tocó ninguna banda de
  // tolerancia — sigue en las mismas unidades ("ratio" normalizado por
  // longitud de pata) y con los mismos umbrales de conformationKnowledgeBase.ts.
  // NOTA (2026-08-19, fix doble penalización pedido por Ramon): este bloque
  // YA NO genera un hallazgo propio — antes competía por fuera del
  // mecanismo de la pata (ver loop de abajo), así que una misma pata podía
  // descontar dos veces (una vez acá como base_narrow/wide bilateral, otra
  // vez como carpus_valgus/toe_in de esa pata). `base_narrow`/`base_wide`
  // ahora es un candidato MÁS dentro de la competencia por pata (Origen 0,
  // ver más abajo) — se sigue calculando la versión bilateral acá SOLO para
  // guardarla en rawMetrics.baseWidthRatio (diagnóstico/compatibilidad, la
  // usa también /_diag/frontalrepeat) y para referenceMetrics, sin que
  // pueda penalizar por sí sola.
  if (shoulderL && shoulderR && hoofL && hoofR) {
    const legs: Array<{ side: Side; shoulder: LandmarkPoint; hoof: LandmarkPoint }> = [
      { side: "left", shoulder: shoulderL, hoof: hoofL },
      { side: "right", shoulder: shoulderR, hoof: hoofR },
    ];
    const lateralOffsets: number[] = [];
    for (const leg of legs) {
      const legLength = distance(toVec(leg.shoulder), toVec(leg.hoof));
      if (legLength <= 0) continue;
      const horizontalOffset = leg.hoof.x - leg.shoulder.x;
      const normalized = horizontalOffset / legLength;
      const lateralSign = leg.side === "left" ? 1 : -1;
      lateralOffsets.push(normalized * lateralSign);
    }
    if (lateralOffsets.length > 0) {
      const ratio = lateralOffsets.reduce((a, b) => a + b, 0) / lateralOffsets.length;
      rawMetrics.baseWidthRatio = ratio;
    }
  }

  // --- Por pata: carpus_valgus/varus, toe_in/toe_out — dominante entre las 3 familias de esa pata ---
  for (const side of ["left", "right"] as const) {
    const shoulder = side === "left" ? shoulderL : shoulderR;
    const hoof = side === "left" ? hoofL : hoofR;
    const carpus = get(lm, side === "left" ? "carpusLeft" : "carpusRight");
    const fetlock = get(lm, side === "left" ? "fetlockLeft" : "fetlockRight");
    const hoofToe = get(lm, side === "left" ? "hoofToeLeft" : "hoofToeRight");
    const hoofHeel = get(lm, side === "left" ? "hoofHeelLeft" : "hoofHeelRight");
    const sign = medialSign(side);

    type Candidate = { defectId: string; measured: number; absDev: number; conf: number; metricKey: string };
    const candidates: Candidate[] = [];

    // Origen 0 (NUEVO, 2026-08-19): pecho→casco completo, whole-leg splay
    // (base_narrow/base_wide) — offset del CASCO respecto a la vertical que
    // baja del HOMBRO de esa misma pata. Ver nota grande arriba: antes se
    // calculaba bilateral y por fuera de esta competencia; ahora es un
    // candidato más, para que no pueda descontar dos veces junto con
    // carpus_valgus/varus o toe_in/toe_out de la misma pata.
    const baseOffsetKey = `baseOffset.${side}`;
    if (shoulder && hoof) {
      const legLength = distance(toVec(shoulder), toVec(hoof));
      if (legLength > 0) {
        const normalized = (hoof.x - shoulder.x) / legLength;
        const medialComponent = normalized * sign; // positivo = medial (base_narrow), negativo = lateral (base_wide) — mismo criterio de signo que carpus/toe abajo.
        rawMetrics[baseOffsetKey] = medialComponent;
        const conf = finalConf(combinedConfidence([shoulder, hoof]));
        candidates.push({
          defectId: medialComponent >= 0 ? "base_narrow" : "base_wide",
          measured: medialComponent,
          absDev: Math.abs(medialComponent),
          conf,
          metricKey: baseOffsetKey,
        });
      }
    }

    // Origen 1: pecho→carpo (carpus_valgus/varus) — offset del carpo respecto a la línea hombro→casco de SU PROPIA pata.
    const carpusOffsetKey = `carpusOffset.${side}`;
    if (shoulder && hoof && carpus) {
      const legLength = distance(toVec(shoulder), toVec(hoof));
      if (legLength > 0) {
        const rawOffset = signedPerpendicularOffset(toVec(carpus), toVec(shoulder), toVec(hoof));
        const normalized = rawOffset / legLength;
        const medialComponent = normalized * sign; // positivo = medial, negativo = lateral
        rawMetrics[carpusOffsetKey] = medialComponent;
        const conf = finalConf(combinedConfidence([shoulder, hoof, carpus]));
        candidates.push({
          defectId: medialComponent >= 0 ? "carpus_valgus" : "carpus_varus",
          measured: medialComponent,
          absDev: Math.abs(medialComponent),
          conf,
          metricKey: carpusOffsetKey,
        });
      }
    }

    // Origen 2: menudillo→casco (toe_in/toe_out) — rotación del casco
    // respecto a la vertical que baja del menudillo.
    //
    // CORRECCIÓN DE ESTABILIDAD (2026-08-14, autorizada por Ramon junto
    // con la corrección de consistencia izquierda/derecha, como
    // continuación del trabajo de baseWidthRatio). Causa raíz real
    // (confirmada con los datos crudos de la prueba de 10 corridas de
    // baseWidthRatio, donde ya se veía este mismo síntoma en toe_in/
    // toe_out): el cálculo original usaba SOLO fetlock→hoofToe, un
    // segmento corto (el menudillo y la punta del casco están muy cerca
    // verticalmente en la foto) — un ángulo calculado sobre un tramo
    // corto es extremadamente sensible a ruido de landmarks, porque el
    // mismo error de pocos pixeles en x pesa mucho más cuando el tramo
    // en y es corto (misma causa raíz que baseWidthRatio antes de
    // corregirse, ver comentario grande más arriba).
    //
    // Fix: se promedia esa medición con fetlock→hoofHeel, que mide la
    // MISMA rotación del casco (el talón y la punta de un casco rotan
    // juntos, es una sola cápsula rígida) con el mismo origen anatómico
    // (menudillo) — sigue siendo una desviación puramente distal, no se
    // mezcla con carpus_valgus/varus ni con base_narrow/wide. Promediar
    // 2 mediciones independientes de la MISMA rotación reduce el ruido
    // propio de cada punto sin cambiar qué se mide, sus unidades
    // (grados) ni su tolerancia — mismo principio que ya se usó para
    // baseWidthRatio. Si algún día falta hoofHeel en una foto, se sigue
    // midiendo solo con hoofToe (no se pierde disponibilidad, solo se
    // pierde el promedio).
    const rotationSamples: number[] = [];
    const rotationPoints: LandmarkPoint[] = [];
    if (fetlock) rotationPoints.push(fetlock);
    if (fetlock && hoofToe) {
      rotationSamples.push(angleFromVertical(toVec(fetlock), toVec(hoofToe))); // grados, + = hacia +x
      rotationPoints.push(hoofToe);
    }
    if (fetlock && hoofHeel) {
      rotationSamples.push(angleFromVertical(toVec(fetlock), toVec(hoofHeel)));
      rotationPoints.push(hoofHeel);
    }
    const hoofRotationKey = `hoofRotation.${side}`;
    if (rotationSamples.length > 0) {
      const angle = rotationSamples.reduce((a, b) => a + b, 0) / rotationSamples.length;
      const medialAngle = angle * sign; // positivo = rotación medial
      rawMetrics[hoofRotationKey] = medialAngle;
      const conf = finalConf(combinedConfidence(rotationPoints));
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
      const conf = finalConf(combinedConfidence([hoofMedialL, hoofLateralL, hoofMedialR, hoofLateralR]));
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

  // CONTROL DE PERSPECTIVA (2026-08-19, pedido explícito de Ramon, prioridad
  // alta): Lateral SÍ tiene línea de suelo propia (groundLeft/groundRight —
  // ya se extraían en cada foto pero ningún cálculo los usaba, ver
  // auditoría). Cuando están disponibles, se usan para derivar la
  // vertical/horizontal REAL de la escena (angleFromVerticalCorrected /
  // angleFromGroundPlaneCorrected, geometry.ts) en vez de asumir que "abajo
  // en la imagen" es la vertical real — corrige ángulos falseados por
  // cámara inclinada sin inventar ni suprimir ningún hallazgo. Si no están
  // disponibles, ambas funciones caen de vuelta al cálculo anterior sin
  // cambios (mismo comportamiento que hoy). Si SÍ están disponibles pero su
  // propia confianza de landmark es baja, la corrección puede ser poco
  // fiable — por eso también limita la confianza final de los 2 hallazgos
  // que la usan (pastern angle / verticalidad de la extremidad).
  const groundL = get(lm, "groundLeft");
  const groundR = get(lm, "groundRight");
  const groundVecL = groundL ? toVec(groundL) : undefined;
  const groundVecR = groundR ? toVec(groundR) : undefined;
  const groundConfidence = groundL && groundR ? Math.min(groundL.confidence, groundR.confidence) : 1;
  const finalConf = (landmarkConf: number, useGround = false): number => {
    const base = findingConfidence(landmarkConf, viewConfidence);
    return useGround ? Math.min(base, groundConfidence) : base;
  };

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
      const conf = finalConf(combinedConfidence([elbow, carpus, fetlockFront]));
      const defectId = normalized >= 0 ? "over_at_the_knee" : "calf_kneed";
      findings.push(buildFinding(defectId, undefined, normalized, Math.abs(normalized), conf, ref("kneeOffset")));
    }
  }

  // --- L2/L3 vs L2 (catch-all): cuartilla (upright/long-sloping) COMPITE con
  // verticalidad de toda la extremidad ---
  //
  // CORRECCIÓN DE DOBLE PENALIZACIÓN (2026-08-19, punto 3 de Ramon): antes
  // estos 2 bloques se calculaban y descontaban SIEMPRE los dos, cada uno
  // por su lado — si el mismo problema estructural (extremidad/cuartilla
  // excesivamente vertical) se reflejaba en ambas mediciones a la vez, el
  // caballo perdía puntaje DOS veces por el mismo defecto anatómico. Ahora
  // se calculan y guardan en rawMetrics/referenceMetrics los DOS, igual que
  // antes (nada deja de medirse), pero solo se reporta como Finding el de
  // mayor magnitud relativa a SU PROPIA tolerancia — el mismo mecanismo ya
  // usado en Frontal (carpus/toe/base) y en L4 acá abajo
  // (sickle/post-legged/camped). Otras familias de esta vista (L1, L4) NO
  // se tocan — siguen penalizando de forma completamente independiente
  // ("anomalías independientes pueden seguir penalizando de forma
  // independiente", pedido explícito de Ramon).
  const coronetFront = get(lm, "coronetFront");
  const hoofHeelFront = get(lm, "hoofHeelFront");
  const cannonMidFront = get(lm, "cannonMidFront");
  type UprightCandidate = { defectId: string; measured: number; absDev: number; conf: number; metricKey: string };
  const uprightCandidates: UprightCandidate[] = [];

  if (coronetFront && hoofHeelFront) {
    // Ángulo de la cuartilla respecto al PLANO DEL SUELO, corregido por
    // inclinación real de cámara cuando hay línea de suelo disponible (ver
    // nota de CONTROL DE PERSPECTIVA arriba). BUG REAL corregido acá el
    // 2026-08-14 (ver reporte de reproducibilidad de esa fecha):
    // `angleFromVertical` mide respecto a "derecho hacia ABAJO", y como
    // talón→banda coronaria siempre apunta hacia ARRIBA en la imagen, el
    // cálculo anterior (`90 - Math.abs(angleFromVertical(...))`) daba
    // SIEMPRE un número negativo sin importar la cuartilla real.
    // `angleFromGroundPlaneCorrected` mide directamente el ángulo con el
    // suelo, sin ese problema de signo.
    const angleFromGround = angleFromGroundPlaneCorrected(toVec(hoofHeelFront), toVec(coronetFront), groundVecL, groundVecR);
    // Rango correcto profesional: 45°–50° (ver Kentucky Equine Research,
    // hoof-pastern axis). Centro de referencia: 47.5°.
    const idealCenter = 47.5;
    const deviation = angleFromGround - idealCenter; // positivo = más vertical de lo ideal (upright), negativo = más inclinado (sloping)
    rawMetrics.pasternAngleDeviation = deviation;
    const conf = finalConf(combinedConfidence([coronetFront, hoofHeelFront]), true);
    uprightCandidates.push({
      defectId: deviation >= 0 ? "upright_pastern" : "long_sloping_pastern",
      measured: deviation,
      absDev: Math.abs(deviation),
      conf,
      metricKey: "pasternAngleDeviation",
    });
  }

  if (carpus && cannonMidFront && fetlockFront) {
    const angle = angleFromVerticalCorrected(toVec(carpus), toVec(fetlockFront), groundVecL, groundVecR);
    rawMetrics.legVerticality = angle;
    const conf = finalConf(combinedConfidence([carpus, cannonMidFront, fetlockFront]), true);
    uprightCandidates.push({
      defectId: "excessively_vertical_leg",
      measured: angle,
      absDev: Math.abs(angle),
      conf,
      metricKey: "legVerticality",
    });
  }

  if (uprightCandidates.length > 0) {
    let best: { c: UprightCandidate; magnitude01: number } | null = null;
    for (const c of uprightCandidates) {
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
      const legConf = finalConf(combinedConfidence([buttock, hoofHeelHind, hock]));
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
      const conf = finalConf(combinedConfidence([hock, stifle, fetlockHind]));
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
  const fetlockL = get(lm, "fetlockLeft");
  const fetlockR = get(lm, "fetlockRight");
  const hoofL = get(lm, "hoofCenterLeft");
  const hoofR = get(lm, "hoofCenterRight");

  // CONTROL DE PERSPECTIVA (2026-08-19, pedido explícito de Ramon, prioridad
  // alta): Posterior no tiene línea de suelo propia (a diferencia de
  // Lateral) — mismo chequeo que Frontal (geometry.postureSquarenessConfidence),
  // acá con tuberCoxaeLeft/Right (deberían estar a la misma altura real
  // cuando el caballo está parado cuadrado hacia la cámara, visto de
  // espaldas). Reduce la confianza de TODOS los hallazgos de esta vista si
  // la grupa aparece muy desnivelada en la foto — nunca inventa ni penaliza
  // un defecto que puede ser solo una pata adelantada o cámara rotada.
  const postureConfidence = postureSquarenessConfidence(lm.tuberCoxaeLeft, lm.tuberCoxaeRight);
  const finalConf = (landmarkConf: number): number => Math.min(findingConfidence(landmarkConf, viewConfidence), postureConfidence);

  // --- P1/P2: cow_hocked / bow_hocked (compuesto bilateral, ancho relativo cadera/corvejón/casco) ---
  //
  // AMPLIACIÓN (2026-08-19, punto 4 de Ramon, "mejor diferenciación
  // geométrica de cow-hocked/bow-hocked"): se agrega fetlockWidth como
  // tercera comparación (antes solo cadera-vs-corvejón y corvejón-vs-casco)
  // usando fetlockLeft/Right, que ya se extraían en cada foto posterior
  // pero ningún cálculo los usaba (confirmado en la auditoría). Ninguna
  // tolerancia ni peso cambia — solo se promedia una tercera comparación
  // con el mismo criterio que las 2 que ya existían; si fetlock no está
  // disponible en la foto, sigue funcionando exactamente igual que antes
  // (2 comparaciones).
  if (coxaeL && coxaeR && hockL && hockR && hoofL && hoofR) {
    const pelvisWidth = distance(toVec(coxaeL), toVec(coxaeR));
    const hockWidth = distance(toVec(hockL), toVec(hockR));
    const hoofWidth = distance(toVec(hoofL), toVec(hoofR));
    const fetlockWidth = fetlockL && fetlockR ? distance(toVec(fetlockL), toVec(fetlockR)) : null;
    // Exponer anchos crudos en rawMetrics (punto 4 de Ramon, "separación
    // relativa de corvejones/cascos") — puramente diagnóstico/de
    // referencia, no generan penalización por sí solos (eso lo hace el
    // composite de abajo, que ya estaba y no cambió de criterio).
    rawMetrics.pelvisWidth = pelvisWidth;
    rawMetrics.hockWidth = hockWidth;
    rawMetrics.hoofWidth = hoofWidth;
    if (fetlockWidth !== null) rawMetrics.fetlockWidth = fetlockWidth;
    if (pelvisWidth > 0) {
      // cow-hocked: corvejones más angostos que cadera Y que cascos.
      // bow-hocked: corvejones más anchos que cadera Y que cascos.
      const hockVsPelvis = (hockWidth - pelvisWidth) / pelvisWidth;
      const hockVsHoof = (hockWidth - hoofWidth) / pelvisWidth;
      const comparisons = [hockVsPelvis, hockVsHoof];
      if (fetlockWidth !== null) {
        comparisons.push((hockWidth - fetlockWidth) / pelvisWidth);
      }
      const composite = comparisons.reduce((a, b) => a + b, 0) / comparisons.length;
      rawMetrics.hockWidthComposite = composite;
      const confPoints = [coxaeL, coxaeR, hockL, hockR, hoofL, hoofR];
      if (fetlockWidth !== null) confPoints.push(fetlockL!, fetlockR!);
      const conf = finalConf(combinedConfidence(confPoints));
      const defectId = composite < 0 ? "cow_hocked" : "bow_hocked";
      findings.push(buildFinding(defectId, undefined, composite, Math.abs(composite), conf, ref("hockWidthComposite")));
    }
  }

  // --- Por pata (NUEVO, 2026-08-19, punto 4 de Ramon: "aprovechar los
  // landmarks que YA existen" — alineación cadera→corvejón→menudillo→casco,
  // desviación de corvejón/menudillo de CADA pata) ---
  //
  // Mismo principio geométrico que carpus_valgus/varus en Frontal y
  // over_at_the_knee en Lateral: offset perpendicular de un punto respecto
  // a la línea recta que une el origen proximal (tuberCoxae) con el punto
  // distal (hoofCenter) de ESA MISMA pata, normalizado por la longitud de
  // esa línea. Es independiente del compuesto bilateral cow_hocked/bow_hocked
  // de arriba (que compara ANCHOS entre las 2 patas) — mide otra cosa: si
  // UN punto de una pata se desvía de la línea recta de su propia pata.
  // hock_deviation_in/out compite con fetlock_deviation_in/out DENTRO de la
  // misma pata (ver doubleCountingRule en conformationKnowledgeBase.ts) para
  // no descontar dos veces si ambos puntos se desvían juntos por el mismo
  // problema físico — mismo mecanismo que en Frontal/L4/L2-L3 de acá arriba.
  //
  // NO se implementa todavía orientación del casco posterior (pedido
  // explícito de Ramon) — requeriría landmarks nuevos (hoofToeHind/
  // hoofHeelHind no existen hoy en POSTERIOR_LANDMARK_IDS).
  for (const side of ["left", "right"] as const) {
    const coxae = side === "left" ? coxaeL : coxaeR;
    const hock = side === "left" ? hockL : hockR;
    const fetlock = side === "left" ? fetlockL : fetlockR;
    const hoof = side === "left" ? hoofL : hoofR;
    const sign = medialSign(side);

    type Candidate = { defectId: string; measured: number; absDev: number; conf: number; metricKey: string };
    const candidates: Candidate[] = [];

    if (coxae && hoof) {
      const legLength = distance(toVec(coxae), toVec(hoof));
      if (legLength > 0) {
        if (hock) {
          const rawOffset = signedPerpendicularOffset(toVec(hock), toVec(coxae), toVec(hoof));
          const normalized = (rawOffset / legLength) * sign; // positivo = medial (hock_deviation_in), negativo = lateral (hock_deviation_out) — misma convención de signo que carpus_valgus/varus en Frontal.
          const key = `hockDeviation.${side}`;
          rawMetrics[key] = normalized;
          const conf = finalConf(combinedConfidence([coxae, hock, hoof]));
          candidates.push({
            defectId: normalized >= 0 ? "hock_deviation_in" : "hock_deviation_out",
            measured: normalized,
            absDev: Math.abs(normalized),
            conf,
            metricKey: key,
          });
        }
        if (fetlock) {
          const rawOffset = signedPerpendicularOffset(toVec(fetlock), toVec(coxae), toVec(hoof));
          const normalized = (rawOffset / legLength) * sign;
          const key = `fetlockDeviation.${side}`;
          rawMetrics[key] = normalized;
          const conf = finalConf(combinedConfidence([coxae, fetlock, hoof]));
          candidates.push({
            defectId: normalized >= 0 ? "fetlock_deviation_in" : "fetlock_deviation_out",
            measured: normalized,
            absDev: Math.abs(normalized),
            conf,
            metricKey: key,
          });
        }
      }
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
          buildFinding(best.c.defectId, side, best.c.measured, best.c.absDev, best.c.conf, ref(best.c.metricKey))
        );
      }
    }
  }

  return { findings, rawMetrics };
}
