// Corrección de consistencia IZQUIERDA/DERECHA — autorizada por Ramon
// (2026-08-14, "Autorización — corregir consistencia izquierda/derecha"),
// como continuación del trabajo de estabilidad de baseWidthRatio.
//
// PROBLEMA REAL encontrado en la prueba de repetibilidad de Frontal (10
// corridas, misma foto, ver reporte de esa fecha): en 1 de 10 corridas el
// modelo de visión etiquetó "Left"/"Right" al revés respecto a las otras
// 9 — shoulderLeft apareció del lado de la imagen donde en las demás
// corridas aparecía shoulderRight (y lo mismo, consistentemente, en
// hoofCenterLeft/Right). El prompt de extracción
// (landmarkExtractionPrompt.ts) ya es explícito ("Left/Right es siempre
// el lado del caballo, nunca el de la foto"), pero el modelo se equivocó
// igual una vez en diez — un error de IDENTIFICACIÓN, no de precisión de
// landmarks.
//
// Esta corrección es determinística y NO usa IA: para una foto FRONTAL o
// POSTERIOR (las únicas vistas con landmarks pareados izquierda/derecha),
// el lado izquierdo del caballo SIEMPRE aparece más hacia la derecha de
// la imagen (mayor x) que el lado derecho, cuando el caballo está parado
// de frente o de espaldas a la cámara — es una convención geométrica
// fija que NO depende de ningún defecto de conformación real: un caballo
// con base angosta, base ancha, toe-in, toe-out, cow-hocked o bow-hocked
// sigue teniendo su pata izquierda del lado derecho de la foto. Ningún
// defecto real "cruza" las patas de lado. Por eso comparar el x de cada
// par izquierda/derecha es un chequeo de IDENTIFICACIÓN, no una medición
// anatómica — no cambia ningún criterio, tolerancia, ni estándar
// profesional (condición explícita de Ramon), solo corrige a qué pata
// física corresponde cada etiqueta ANTES de que rmPriorityRules.ts
// calcule ningún hallazgo.
//
// Método: por cada par de landmarks (ej. shoulderLeft/shoulderRight) que
// esté visible en ambos lados, se vota "normal" (left.x > right.x) o
// "invertido" (left.x < right.x). Si más pares votan "invertido" que
// "normal", se intercambian TODOS los pares Left/Right de esa foto (no
// solo los que votaron distinto) — el error de identificación del modelo
// es todo-o-nada por foto (confunde el lado completo, no una pata sí y
// otra no), así que corregir parcialmente dejaría la foto en un estado
// mixto peor que no corregir nada. Empate o sin pares disponibles → no
// se toca nada (no hay evidencia suficiente para corregir con confianza).

import { LandmarkPoint, ViewName } from "./landmarks";

const FRONTAL_LR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["shoulderLeft", "shoulderRight"],
  ["carpusLeft", "carpusRight"],
  ["cannonDistalLeft", "cannonDistalRight"],
  ["fetlockLeft", "fetlockRight"],
  ["hoofCenterLeft", "hoofCenterRight"],
  ["hoofToeLeft", "hoofToeRight"],
  ["hoofHeelLeft", "hoofHeelRight"],
  ["hoofMedialLeft", "hoofMedialRight"],
  ["hoofLateralLeft", "hoofLateralRight"],
];

const POSTERIOR_LR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["tuberCoxaeLeft", "tuberCoxaeRight"],
  ["hockLeft", "hockRight"],
  ["cannonDistalLeft", "cannonDistalRight"],
  ["fetlockLeft", "fetlockRight"],
  ["hoofCenterLeft", "hoofCenterRight"],
  ["hoofMedialLeft", "hoofMedialRight"],
  ["hoofLateralLeft", "hoofLateralRight"],
];

function pairsForView(view: ViewName | "unclear"): ReadonlyArray<readonly [string, string]> | null {
  if (view === "frontal") return FRONTAL_LR_PAIRS;
  if (view === "posterior") return POSTERIOR_LR_PAIRS;
  return null; // lateral no tiene landmarks pareados izquierda/derecha; "unclear" no tiene landmarks
}

export interface SideConsistencyResult {
  landmarks: Record<string, LandmarkPoint>;
  swapped: boolean;
  votesNormal: number;
  votesInverted: number;
}

/**
 * Revisa y, si hace falta, corrige la identificación izquierda/derecha
 * de UNA extracción de landmarks ya parseada. No modifica el objeto
 * recibido — devuelve un mapa nuevo (el mismo objeto si no hubo que
 * corregir nada).
 */
export function correctLeftRightConsistency(
  view: ViewName | "unclear",
  landmarks: Record<string, LandmarkPoint>
): SideConsistencyResult {
  const pairs = pairsForView(view);
  if (!pairs) {
    return { landmarks, swapped: false, votesNormal: 0, votesInverted: 0 };
  }

  let votesNormal = 0;
  let votesInverted = 0;
  for (const [leftId, rightId] of pairs) {
    const l = landmarks[leftId];
    const r = landmarks[rightId];
    if (!l || !r || !l.visible || !r.visible) continue;
    if (l.x > r.x) votesNormal++;
    else if (l.x < r.x) votesInverted++;
    // l.x === r.x exacto: caso degenerado, no vota.
  }

  if (votesInverted === 0 || votesInverted <= votesNormal) {
    return { landmarks, swapped: false, votesNormal, votesInverted };
  }

  const corrected: Record<string, LandmarkPoint> = { ...landmarks };
  for (const [leftId, rightId] of pairs) {
    const l = landmarks[leftId];
    const r = landmarks[rightId];
    if (l !== undefined) corrected[rightId] = l;
    else delete corrected[rightId];
    if (r !== undefined) corrected[leftId] = r;
    else delete corrected[leftId];
  }

  return { landmarks: corrected, swapped: true, votesNormal, votesInverted };
}
