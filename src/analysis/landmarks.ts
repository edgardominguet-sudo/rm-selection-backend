// Anatomical Landmark Model — pieza (A) del motor RM de Análisis Anatómico
// (2026-08-14, "MOTOR PROFESIONAL DE ANÁLISIS ANATÓMICO RM SELECTION").
//
// Reemplaza el enfoque anterior ("mostrale las 2 fotos a la IA y que
// devuelva 9 números del 0 al 10") por un pipeline de dos pasos:
//   1) el modelo de visión extrae PUNTOS anatómicos (coordenadas de pixel,
//      normalizadas 0..1 respecto al ancho/alto de la foto) — una tarea
//      mucho más acotada y verificable que "puntuar", con una confianza por
//      punto y un flag de si el punto es visible/estimable en esa foto;
//   2) TODO lo demás (ejes, ángulos, desviaciones, severidad, score) se
//      calcula con matemática determinística en este backend (ver
//      geometry.ts, rmPriorityRules.ts, scoringEngine.ts) — NUNCA le
//      pedimos al modelo generativo que "elija" un puntaje directamente.
//
// Esto es lo que permite que el motor mida en vez de opinar: dos llamadas
// con las mismas coordenadas de landmarks producen exactamente el mismo
// resultado, porque esa segunda mitad no tiene ninguna aleatoriedad.

export type ViewName = "frontal" | "lateral" | "posterior";

/** Lado de una extremidad — solo aplica a landmarks pareados (frontal/posterior). */
export type Side = "left" | "right";

/**
 * Un punto anatómico tal como lo devuelve la extracción de landmarks.
 * Coordenadas NORMALIZADAS (0.0–1.0) respecto al ancho/alto de la foto —
 * así no importa la resolución real de cada imagen, y las mismas fórmulas
 * de geometry.ts sirven para cualquier foto.
 */
export interface LandmarkPoint {
  x: number;
  y: number;
  /** 0.0–1.0 — qué tan seguro está el modelo de este punto puntual. */
  confidence: number;
  /** false = el punto no es visible/estimable en esta foto (oclusión, encuadre, ángulo). Si es false, x/y son un placeholder (0,0) y NO deben usarse. */
  visible: boolean;
}

// ============================================================
// VISTA FRONTAL — landmarks por lado (left/right desde la perspectiva
// del CABALLO, no de la cámara — el lado izquierdo del caballo aparece a
// la derecha de la foto cuando el caballo mira hacia la cámara. Igual que
// el side de POSTERIOR).
//
// Cadena requerida por las instrucciones RM:
// hombro/pecho → antebrazo → centro del carpo → caña → menudillo →
// cuartilla → casco.
// ============================================================
export const FRONTAL_LANDMARK_IDS = [
  // Proximal — referencia de ancho de pecho, punto de partida de F1/F2
  // (base-narrow/base-wide empiezan ACÁ, no en el casco).
  "chestCenter", // punto medio del pecho, entre el nacimiento de ambos miembros
  "shoulderLeft",
  "shoulderRight",
  // Antebrazo / carpo — punto de partida de las desviaciones que empiezan
  // en la rodilla (carpal valgus/varus), distintas de base-narrow/wide.
  "carpusLeft",
  "carpusRight",
  // Caña / menudillo
  "cannonDistalLeft", // extremo distal de la caña, justo arriba del menudillo
  "cannonDistalRight",
  "fetlockLeft",
  "fetlockRight",
  // Casco — donde empiezan las desviaciones distales puras (toe-in/toe-out
  // como orientación del casco sin que el resto de la extremidad esté
  // desviado) y donde se mide F3 (asimetría de cascos).
  "hoofCenterLeft", // punto medio del casco a nivel del suelo
  "hoofCenterRight",
  "hoofToeLeft", // borde más craneal (adelante) del casco
  "hoofToeRight",
  "hoofHeelLeft", // borde más caudal (atrás) del casco
  "hoofHeelRight",
  "hoofMedialLeft", // borde medial (hacia el centro) del casco, a nivel del suelo
  "hoofMedialRight",
  "hoofLateralLeft", // borde lateral (hacia afuera) del casco, a nivel del suelo
  "hoofLateralRight",
] as const;
export type FrontalLandmarkId = (typeof FRONTAL_LANDMARK_IDS)[number];

// ============================================================
// VISTA LATERAL — un solo lado visible (el más cercano a la cámara).
// Requiere landmarks del miembro anterior Y del miembro posterior, ambos
// en la misma foto (de costado se ven los dos).
//
// Anterior: hombro → codo → carpo → caña → menudillo → cuartilla →
// casco/talón.
// Posterior: grupa → muslo → corvejón → caña posterior → menudillo →
// cuartilla → casco posterior.
// ============================================================
export const LATERAL_LANDMARK_IDS = [
  // --- Miembro anterior ---
  "pointOfShoulder",
  "elbow",
  "carpus", // "la rodilla" (knee) — L1 (over at the knee) se mide acá
  "cannonMidFront",
  "fetlockFront",
  "pasternMidFront", // punto medio de la cuartilla anterior
  "coronetFront", // banda coronaria anterior (donde termina la cuartilla y empieza el casco)
  "hoofToeFront",
  "hoofHeelFront",
  // --- Miembro posterior ---
  "pointOfHip", // tuber coxae — referencia proximal para L4 (línea de "camped")
  "pointOfButtock", // tuber ischii — el ancla clásica de la línea vertical de aplomo posterior
  "stifle",
  "hock", // tarso — L4 (sickle-hocked / post-legged) se mide acá
  "cannonMidHind",
  "fetlockHind",
  "pasternMidHind",
  "coronetHind",
  "hoofToeHind",
  "hoofHeelHind",
  // Línea de suelo — 2 puntos para poder proyectar "vertical" real en la
  // foto (una foto rara vez está perfectamente nivelada).
  "groundLeft",
  "groundRight",
] as const;
export type LateralLandmarkId = (typeof LATERAL_LANDMARK_IDS)[number];

// ============================================================
// VISTA POSTERIOR — landmarks por lado, cadena:
// pelvis/grupa → muslo → corvejón → caña → menudillo → cuartilla → casco.
// ============================================================
export const POSTERIOR_LANDMARK_IDS = [
  "pelvisCenter",
  "tuberCoxaeLeft", // punta de la cadera — ancho proximal, referencia de P1/P2
  "tuberCoxaeRight",
  "hockLeft",
  "hockRight",
  "cannonDistalLeft",
  "cannonDistalRight",
  "fetlockLeft",
  "fetlockRight",
  "hoofCenterLeft",
  "hoofCenterRight",
  "hoofMedialLeft",
  "hoofMedialRight",
  "hoofLateralLeft",
  "hoofLateralRight",
] as const;
export type PosteriorLandmarkId = (typeof POSTERIOR_LANDMARK_IDS)[number];

export type LandmarkIdForView<V extends ViewName> = V extends "frontal"
  ? FrontalLandmarkId
  : V extends "lateral"
  ? LateralLandmarkId
  : PosteriorLandmarkId;

/** Mapa completo de landmarks detectados en UNA foto de UNA vista. */
export type ViewLandmarks<V extends ViewName = ViewName> = Partial<Record<LandmarkIdForView<V>, LandmarkPoint>>;

export function landmarkIdsForView(view: ViewName): readonly string[] {
  if (view === "frontal") return FRONTAL_LANDMARK_IDS;
  if (view === "lateral") return LATERAL_LANDMARK_IDS;
  return POSTERIOR_LANDMARK_IDS;
}

/** Resultado crudo de la extracción de landmarks de UNA foto. */
export interface LandmarkExtractionResult {
  view: ViewName | "unclear";
  valid: boolean;
  invalidReason: string | null;
  landmarks: ViewLandmarks;
  /** Confianza global de esta extracción (foto entera) — distinta de la confianza por punto; combina calidad de encuadre/ángulo/luz. */
  overallConfidence: number;
}
