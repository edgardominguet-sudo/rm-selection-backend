// Motor de geometría pura — matemática determinística sobre coordenadas de
// landmarks ya extraídas (ver landmarks.ts). CERO llamadas a IA acá adentro,
// a propósito: esta es la mitad del motor que garantiza que "las mismas
// coordenadas de entrada" produzcan siempre "exactamente el mismo resultado
// numérico" (requisito explícito de la tarea: "el motor mide, no opina").

import { LandmarkPoint } from "./landmarks";

export interface Vec2 {
  x: number;
  y: number;
}

export function toVec(p: LandmarkPoint): Vec2 {
  return { x: p.x, y: p.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Ángulo del vector a→b respecto a la VERTICAL de la foto (0° = a→b
 * apunta derecho hacia abajo, como una plomada). Positivo = b está
 * desviado hacia la derecha de la imagen respecto a a; negativo = hacia
 * la izquierda. En grados.
 *
 * Nota de coordenadas de imagen: y crece hacia ABAJO (convención estándar
 * de coordenadas de pixel), así que "abajo" es +y.
 */
export function angleFromVertical(a: Vec2, b: Vec2): number {
  const v = sub(b, a);
  // atan2(x, y) da el ángulo respecto al eje +y (abajo), que es la
  // vertical "hacia abajo" que queremos como referencia 0°.
  return (Math.atan2(v.x, v.y) * 180) / Math.PI;
}

/**
 * Ángulo del vector a→b respecto a la HORIZONTAL (0° = a→b apunta
 * derecho hacia la derecha). Usado para ejes de casco (toe-heel) y para
 * medir inclinación de líneas que deberían ser horizontales (ancho de
 * pecho, ancho de cadera).
 */
export function angleFromHorizontal(a: Vec2, b: Vec2): number {
  const v = sub(b, a);
  return (Math.atan2(v.y, v.x) * 180) / Math.PI;
}

/**
 * Ángulo (0°–90°) que el segmento a→b forma con el PLANO DEL SUELO
 * (horizontal), sin importar hacia qué lado se incline — 90° = el
 * segmento es perfectamente vertical (como un poste), 0° = perfectamente
 * horizontal (acostado). A diferencia de `angleFromVertical`, que mide
 * dirección con signo respecto a "derecho hacia abajo" (útil para ejes
 * que SE ESPERA que apunten hacia abajo, como una plomada), esta función
 * sirve para segmentos que naturalmente apuntan HACIA ARRIBA en la
 * imagen (ej. talón→banda coronaria de la cuartilla) — usar
 * `angleFromVertical` ahí daría valores en el rango [90°,180°] para
 * cualquier orientación físicamente plausible, y `90 - abs(ese valor)`
 * terminaría siempre negativo (bug real encontrado y corregido
 * 2026-08-14 — ver rmPriorityRules.ts, cálculo del ángulo cuartilla-suelo,
 * y el reporte de reproducibilidad de esa fecha).
 */
export function angleFromGroundPlane(a: Vec2, b: Vec2): number {
  const v = sub(b, a);
  return (Math.atan2(Math.abs(v.y), Math.abs(v.x)) * 180) / Math.PI;
}

/**
 * Ángulo interior (en grados, 0–180) en el vértice `at`, formado por los
 * segmentos at→p1 y at→p2. Sirve para medir el ángulo de una articulación
 * (ej. ángulo del corvejón: vértice=hock, p1=stifle, p2=fetlockHind).
 */
export function jointAngle(at: Vec2, p1: Vec2, p2: Vec2): number {
  const v1 = sub(p1, at);
  const v2 = sub(p2, at);
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (mag === 0) return 0;
  const cos = Math.min(1, Math.max(-1, dot / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Desplazamiento perpendicular del punto `p` respecto a la línea recta
 * que pasa por `lineA` y `lineB`, expresado en las mismas unidades que
 * las coordenadas de entrada (normalizadas 0..1), CON SIGNO: positivo =
 * `p` cae al lado derecho del vector lineA→lineB, negativo = al lado
 * izquierdo.
 *
 * Esta es la operación central de L1 (over at the knee) y L4
 * (camped-under/camped-out/sickle-hocked/post-legged): "¿cuánto se
 * desvía este landmark de la línea vertical esperada entre estos otros
 * dos landmarks?"
 */
export function signedPerpendicularOffset(p: Vec2, lineA: Vec2, lineB: Vec2): number {
  const line = sub(lineB, lineA);
  const len = Math.hypot(line.x, line.y);
  if (len === 0) return 0;
  const toP = sub(p, lineA);
  // Producto cruz 2D (line × toP) / |line| = distancia perpendicular con signo.
  const cross = line.x * toP.y - line.y * toP.x;
  return cross / len;
}

/**
 * Escala de referencia para normalizar distancias en pixeles-normalizados
 * a "proporción del cuerpo", para que la MISMA desviación en pixeles no
 * pese distinto en una foto tomada de más cerca o de más lejos. Se usa
 * la distancia entre dos landmarks estables y casi siempre visibles como
 * unidad (ej. ancho de pecho en frontal, longitud de la caña en lateral).
 */
export function referenceScale(a: LandmarkPoint | undefined, b: LandmarkPoint | undefined): number | null {
  if (!a || !b || !a.visible || !b.visible) return null;
  const d = distance(toVec(a), toVec(b));
  return d > 0 ? d : null;
}

/**
 * Desviación normalizada: una distancia/offset en coordenadas de imagen,
 * dividida por la escala de referencia — da un número adimensional
 * comparable entre fotos de distinta resolución/distancia/zoom. Devuelve
 * null si no hay escala de referencia confiable (ej. landmark de escala
 * no visible) — el llamador debe tratar null como "no medible", nunca
 * como 0.
 */
export function normalize(rawValue: number, scaleUnit: number | null): number | null {
  if (scaleUnit === null || scaleUnit === 0) return null;
  return rawValue / scaleUnit;
}

/**
 * Simetría bilateral: compara una magnitud (ángulo, proporción, offset
 * normalizado) entre lado izquierdo y derecho. Devuelve la diferencia
 * absoluta — un valor "grande" indica asimetría. El llamador decide el
 * umbral de tolerancia (ver conformationKnowledgeBase.ts).
 */
export function bilateralDifference(left: number, right: number): number {
  return Math.abs(left - right);
}

/**
 * Confianza combinada de una medición que depende de N landmarks: el
 * mínimo de las confianzas individuales (una medición es tan confiable
 * como su punto MÁS débil, no el promedio — evita que un landmark muy
 * seguro "tape" a otro dudoso en la misma medición).
 */
export function combinedConfidence(points: Array<LandmarkPoint | undefined>): number {
  const valid = points.filter((p): p is LandmarkPoint => !!p && p.visible);
  if (valid.length < points.length) return 0; // falta algún landmark requerido: medición no confiable
  if (valid.length === 0) return 0;
  return Math.min(...valid.map((p) => p.confidence));
}
