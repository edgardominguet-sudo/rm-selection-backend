// Prompt de EXTRACCIÓN DE LANDMARKS — reemplaza al prompt anterior que le
// pedía a la IA "puntuar" 9 parámetros directamente (ver prompt.ts,
// LEGADO — se mantiene el archivo por compatibilidad de las filas viejas
// en AnalysisResult, pero el motor nuevo ya no lo usa para generar
// puntajes).
//
// La tarea que le pedimos al modelo acá es deliberadamente MÁS ACOTADA:
// ubicar puntos anatómicos y decir qué tan seguro está de cada uno — NO
// evaluar, NO puntuar, NO opinar sobre calidad de conformación. Esa
// segunda parte la hace geometry.ts + rmPriorityRules.ts + scoringEngine.ts
// con matemática pura, determinística, sobre las coordenadas que devuelve
// este paso.

import { LandmarkPoint, ViewName, landmarkIdsForView } from "./landmarks";

export interface RawLandmarkExtractionResponse {
  view?: unknown;
  valid?: unknown;
  invalidReason?: unknown;
  overallConfidence?: unknown;
  landmarks?: Record<string, unknown>;
}

export interface ParsedLandmarkExtraction {
  view: ViewName | "unclear";
  valid: boolean;
  invalidReason: string | null;
  overallConfidence: number;
  landmarks: Record<string, LandmarkPoint>;
}

const ALL_VIEW_NAMES: ViewName[] = ["frontal", "lateral", "posterior"];

/**
 * `expectedView`: cuando se conoce de antemano la vista (fotos del
 * caballo referente, ya etiquetadas por rol al configurarlas — ver
 * referenceHorse.ts) se lo indicamos al modelo para que no tenga que
 * adivinar y podemos pedirle DIRECTAMENTE los landmarks de esa vista. Si
 * es `undefined` (fotos del Hip, en cualquier orden), primero tiene que
 * clasificar la vista igual que hacía el prompt legado.
 */
export function buildLandmarkExtractionPrompt(opts: { expectedView?: ViewName; photoLabel: string }): string {
  const viewsToDescribe = opts.expectedView ? [opts.expectedView] : ALL_VIEW_NAMES;
  const landmarkListing = viewsToDescribe
    .map((v) => `Si la vista es "${v}", los landmarks requeridos son EXACTAMENTE estos IDs: ${landmarkIdsForView(v).join(", ")}.`)
    .join("\n");

  const viewInstruction = opts.expectedView
    ? `Esta foto corresponde a la vista "${opts.expectedView}" (ya confirmada) — no hace falta que la clasifiques, pero confirmá el campo "view" con ese mismo valor y "valid" según si podés extraer landmarks confiables.`
    : `Primero determiná qué vista representa esta foto: "lateral" (de costado, perfil completo visible), "frontal" (de frente, mirando hacia la cámara), "posterior" (de atrás, grupa/cuartos traseros), o "unclear" si no corresponde claramente a ninguna o el caballo no es identificable.`;

  return `Sos un sistema de localización de puntos anatómicos (landmarks) en fotografías de caballos Pura Sangre yearling, para un motor de análisis de conformación. Tu ÚNICA tarea es UBICAR puntos anatómicos con sus coordenadas de pixel — NO evalúes conformación, NO opines si el caballo es bueno o malo, NO asignes ningún puntaje. Esa parte la hace otro sistema con matemática determinística a partir de las coordenadas que vos devolvés.

Foto a analizar: ${opts.photoLabel}.

${viewInstruction}

${landmarkListing}

Para CADA landmark de la lista correspondiente a la vista detectada, devolvé:
- "x", "y": coordenadas NORMALIZADAS (0.0 a 1.0) respecto al ancho y alto de la imagen — (0,0) es la esquina superior izquierda, (1,1) la esquina inferior derecha.
- "confidence": qué tan seguro estás de la ubicación EXACTA de ese punto puntual, de 0.0 a 1.0.
- "visible": true si el punto es identificable en esta foto (aunque sea parcialmente, con algo de incertidumbre), false si está completamente oculto, fuera de encuadre, o no se puede estimar de forma razonable (en ese caso x/y pueden ser 0).

Sé preciso: cada landmark tiene una definición anatómica específica (ver nombres de los IDs, en inglés técnico estándar — ej. "carpusLeft" es el centro del carpo/rodilla del miembro izquierdo del caballo, "hoofToeFront" es el borde más craneal del casco anterior a nivel del suelo). "Left"/"Right" son SIEMPRE el lado del CABALLO (su izquierda/derecha anatómica), no el lado de la imagen — cuando el caballo mira hacia la cámara, su lado izquierdo aparece del lado derecho de la foto.

Precisión adicional para landmarks de las extremidades ANTERIORES en vista FRONTAL (shoulderLeft/Right, carpusLeft/Right, fetlockLeft/Right, hoofCenterLeft/Right): estos puntos se usan para comparar qué tan ancho o angosto está parado el caballo a distintas alturas de la pata. Si el caballo NO está parado perfectamente cuadrado hacia la cámara (una mano ligeramente más adelantada que la otra, común en fotos de parada), estimá la posición horizontal de cada landmark como si vieras la extremidad proyectada de frente sobre el plano de la cámara — no la posición aparente distorsionada por la perspectiva de una pata más cerca o más lejos del lente. Mantené el mismo criterio de estimación en TODOS los landmarks de esta lista dentro de esta misma foto, para que las comparaciones de ancho entre alturas (hombro vs. carpo vs. menudillo vs. casco) sean consistentes entre sí.

Si la vista es "unclear" o "valid" es false, devolvé "landmarks": {} (objeto vacío).

Respondé ÚNICAMENTE con un objeto JSON, sin texto adicional, con esta forma exacta:
{
  "view": "frontal",
  "valid": true,
  "invalidReason": null,
  "overallConfidence": 0.9,
  "landmarks": {
    "shoulderLeft": {"x": 0.35, "y": 0.22, "confidence": 0.92, "visible": true},
    "shoulderRight": {"x": 0.63, "y": 0.21, "confidence": 0.9, "visible": true}
  }
}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function extractLandmarkResponse(text: string): ParsedLandmarkExtraction | null {
  let cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  let raw: RawLandmarkExtractionResponse;
  try {
    raw = JSON.parse(cleaned) as RawLandmarkExtractionResponse;
  } catch {
    return null;
  }

  const view = typeof raw.view === "string" && ALL_VIEW_NAMES.includes(raw.view as ViewName) ? (raw.view as ViewName) : "unclear";
  const valid = typeof raw.valid === "boolean" ? raw.valid : false;
  const invalidReason = typeof raw.invalidReason === "string" ? raw.invalidReason : null;
  const overallConfidence = isFiniteNumber(raw.overallConfidence) ? Math.min(1, Math.max(0, raw.overallConfidence)) : 0;

  const landmarks: Record<string, LandmarkPoint> = {};
  if (raw.landmarks && typeof raw.landmarks === "object") {
    for (const [id, value] of Object.entries(raw.landmarks)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y)) continue;
      landmarks[id] = {
        x: Math.min(1, Math.max(0, v.x)),
        y: Math.min(1, Math.max(0, v.y)),
        confidence: isFiniteNumber(v.confidence) ? Math.min(1, Math.max(0, v.confidence)) : 0,
        visible: typeof v.visible === "boolean" ? v.visible : false,
      };
    }
  }

  return { view, valid, invalidReason, overallConfidence, landmarks };
}
