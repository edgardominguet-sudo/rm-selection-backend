// Protege el motor de geometría pura (pieza (A)/(C) del motor RM —
// analysis/geometry.ts): matemática determinística sobre landmarks. Si
// alguno de estos tests se rompe, significa que una desviación medida en
// una foto real puede empezar a dar un número distinto al de ayer sin que
// haya cambiado el caballo — el tipo de regresión más peligroso posible,
// porque es silenciosa (nadie ve una excepción, solo un score raro).
import {
  toVec,
  sub,
  add,
  scale,
  midpoint,
  distance,
  angleFromVertical,
  angleFromHorizontal,
  angleFromGroundPlane,
  angleFromVerticalCorrected,
  angleFromGroundPlaneCorrected,
  jointAngle,
  signedPerpendicularOffset,
  referenceScale,
  normalize,
  bilateralDifference,
  postureSquarenessConfidence,
  combinedConfidence,
} from "../../src/analysis/geometry";
import { LandmarkPoint } from "../../src/analysis/landmarks";

function pt(x: number, y: number, confidence = 1, visible = true): LandmarkPoint {
  return { x, y, confidence, visible };
}

describe("geometry: vectores básicos", () => {
  test("toVec/sub/add/scale/midpoint/distance", () => {
    const a = toVec(pt(0, 0));
    const b = toVec(pt(3, 4));
    expect(sub(b, a)).toEqual({ x: 3, y: 4 });
    expect(add(a, b)).toEqual({ x: 3, y: 4 });
    expect(scale(b, 2)).toEqual({ x: 6, y: 8 });
    expect(midpoint(a, b)).toEqual({ x: 1.5, y: 2 });
    expect(distance(a, b)).toBe(5); // triángulo 3-4-5
  });
});

describe("geometry: ángulos", () => {
  test("angleFromVertical: un segmento recto hacia abajo da 0°", () => {
    expect(angleFromVertical({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(0, 6);
  });
  test("angleFromVertical: recto hacia la derecha da +90°, hacia la izquierda -90°", () => {
    expect(angleFromVertical({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(90, 6);
    expect(angleFromVertical({ x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(-90, 6);
  });
  test("angleFromHorizontal: recto a la derecha da 0°, recto hacia abajo da +90°", () => {
    expect(angleFromHorizontal({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
    expect(angleFromHorizontal({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 6);
  });
  test("angleFromGroundPlane: siempre 0-90 sin importar el sentido del segmento", () => {
    // Un segmento vertical "hacia arriba en la imagen" (y decreciente) —
    // el caso real que motivó el bug de 2026-08-14 documentado en el
    // código: angleFromVertical daría 180°, esta función debe seguir
    // dando 90° (perfectamente vertical) sin volverse negativa.
    expect(angleFromGroundPlane({ x: 0, y: 1 }, { x: 0, y: 0 })).toBeCloseTo(90, 6);
    expect(angleFromGroundPlane({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
  });
  test("jointAngle: línea recta da 180°, ángulo recto da 90°", () => {
    expect(jointAngle({ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(180, 6);
    expect(jointAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 6);
  });
  test("jointAngle: puntos degenerados (mag=0) no lanzan, dan 0", () => {
    expect(jointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(0);
  });
});

describe("geometry: corrección de perspectiva (línea de suelo)", () => {
  test("angleFromVerticalCorrected sin línea de suelo cae de vuelta a angleFromVertical", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0.1, y: 1 };
    expect(angleFromVerticalCorrected(a, b)).toBeCloseTo(angleFromVertical(a, b), 6);
  });
  test("angleFromVerticalCorrected: una foto inclinada 15° hace que un segmento realmente vertical dé ~0°, no ~-15°", () => {
    // Línea de suelo inclinada 15° respecto a la horizontal de la imagen.
    const tiltRad = (15 * Math.PI) / 180;
    const groundLeft = { x: 0, y: 0 };
    const groundRight = { x: Math.cos(tiltRad), y: Math.sin(tiltRad) };
    // Segmento perpendicular real al suelo (verdaderamente vertical EN LA ESCENA).
    const perp = { x: -Math.sin(tiltRad), y: Math.cos(tiltRad) };
    const a = { x: 0.5, y: 0.5 };
    const b = { x: a.x + perp.x, y: a.y + perp.y };
    const uncorrected = angleFromVertical(a, b);
    const corrected = angleFromVerticalCorrected(a, b, groundLeft, groundRight);
    expect(Math.abs(uncorrected)).toBeGreaterThan(10); // sin corregir, se ve inclinado
    expect(corrected).toBeCloseTo(0, 3); // corregido, es verdaderamente vertical
  });
  test("angleFromGroundPlaneCorrected: recupera 47.5° reales de una cuartilla con cámara inclinada 10° (caso documentado en el código)", () => {
    const tiltRad = (10 * Math.PI) / 180;
    const groundLeft = { x: 0, y: 0 };
    const groundRight = { x: Math.cos(tiltRad), y: Math.sin(tiltRad) };
    const ux = { x: Math.cos(tiltRad), y: Math.sin(tiltRad) };
    const uy = { x: -ux.y, y: ux.x };
    const targetAngleRad = (47.5 * Math.PI) / 180;
    // Construye un segmento a targetAngle respecto al plano del suelo real.
    const dir = {
      x: uy.x * Math.sin(targetAngleRad) + ux.x * Math.cos(targetAngleRad),
      y: uy.y * Math.sin(targetAngleRad) + ux.y * Math.cos(targetAngleRad),
    };
    const a = { x: 0.5, y: 0.5 };
    const b = { x: a.x + dir.x, y: a.y + dir.y };
    const corrected = angleFromGroundPlaneCorrected(a, b, groundLeft, groundRight);
    expect(corrected).toBeCloseTo(47.5, 1);
  });
});

describe("geometry: offset perpendicular con signo", () => {
  test("un punto sobre la línea da offset 0", () => {
    expect(signedPerpendicularOffset({ x: 0.5, y: 5 }, { x: 0.5, y: 0 }, { x: 0.5, y: 10 })).toBeCloseTo(0, 6);
  });
  test("signo distinto a cada lado de la línea", () => {
    const lineA = { x: 0, y: 0 };
    const lineB = { x: 0, y: 1 };
    const right = signedPerpendicularOffset({ x: 1, y: 0.5 }, lineA, lineB);
    const left = signedPerpendicularOffset({ x: -1, y: 0.5 }, lineA, lineB);
    expect(Math.sign(right)).not.toBe(Math.sign(left));
    expect(Math.abs(right)).toBeCloseTo(1, 6);
  });
  test("línea degenerada (lineA==lineB) no lanza, da 0", () => {
    expect(signedPerpendicularOffset({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });
});

describe("geometry: normalización y escala de referencia", () => {
  test("referenceScale: null si algún landmark no es visible", () => {
    expect(referenceScale(pt(0, 0), pt(1, 0, 1, false))).toBeNull();
    expect(referenceScale(undefined, pt(1, 0))).toBeNull();
  });
  test("referenceScale: distancia real cuando ambos son visibles", () => {
    expect(referenceScale(pt(0, 0), pt(3, 4))).toBe(5);
  });
  test("normalize: null si no hay escala (nunca 0 — el llamador no debe tratar 'no medible' como 'sin desviación')", () => {
    expect(normalize(5, null)).toBeNull();
    expect(normalize(5, 0)).toBeNull();
  });
  test("normalize: divide correctamente cuando hay escala", () => {
    expect(normalize(5, 2)).toBe(2.5);
  });
  test("bilateralDifference: valor absoluto, simétrico", () => {
    expect(bilateralDifference(3, 5)).toBe(2);
    expect(bilateralDifference(5, 3)).toBe(2);
    expect(bilateralDifference(-1, 1)).toBe(2);
  });
});

describe("geometry: confianza combinada y de postura", () => {
  test("combinedConfidence: el mínimo de las confianzas, no el promedio", () => {
    expect(combinedConfidence([pt(0, 0, 0.9), pt(1, 1, 0.3), pt(2, 2, 0.95)])).toBeCloseTo(0.3, 6);
  });
  test("combinedConfidence: 0 si falta algún landmark requerido (undefined o no visible)", () => {
    expect(combinedConfidence([pt(0, 0, 0.9), undefined])).toBe(0);
    expect(combinedConfidence([pt(0, 0, 0.9), pt(1, 1, 0.9, false)])).toBe(0);
  });
  test("combinedConfidence: 0 con lista vacía (nunca inventa confianza plena)", () => {
    expect(combinedConfidence([])).toBe(0);
  });
  test("postureSquarenessConfidence: 1.0 cuando los dos puntos están a la misma altura (caballo cuadrado)", () => {
    expect(postureSquarenessConfidence(pt(0, 0.5), pt(1, 0.5))).toBe(1);
  });
  test("postureSquarenessConfidence: penaliza linealmente entre 6% y 30% de diferencia relativa de altura", () => {
    // width=1, diferencia de altura = 0.18 -> heightDiffRatio=0.18, a mitad de camino entre 0.06 y 0.30
    const mid = postureSquarenessConfidence(pt(0, 0), pt(1, 0.18));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
  test("postureSquarenessConfidence: 0 por encima de 30% de diferencia relativa", () => {
    expect(postureSquarenessConfidence(pt(0, 0), pt(1, 0.5))).toBe(0);
  });
  test("postureSquarenessConfidence: sin datos suficientes, no penaliza (devuelve 1, nunca inventa)", () => {
    expect(postureSquarenessConfidence(undefined, pt(1, 0))).toBe(1);
    expect(postureSquarenessConfidence(pt(0, 0, 1, false), pt(1, 0))).toBe(1);
  });
});
