// Prompt del motor de Análisis (IA) — metodología nueva (2026-08-13):
// "NUEVO CABALLO REFERENTE Y SISTEMA DEFINITIVO DE ANÁLISIS IA". Puerto
// directo a Services/AIConformationScoringService.swift (mismo texto,
// misma lógica) — ver ese archivo para la versión que corre en el
// dispositivo cuando el backend no está disponible.
//
// Cambio de fondo respecto a la metodología legado (ver git history de
// este archivo): la comparación deja de ser "similitud fotográfica general"
// (¿se parece esta foto a la foto del referente?) y pasa a ser "anatomía
// comparativa" (¿son anatómicamente equivalentes las proporciones, ejes,
// ángulos y alineaciones de este caballo y las del patrón?) — landmarks,
// proporciones, ejes, ángulos articulares, alineación, simetría, equilibrio
// estructural, NO belleza/color/pelaje/iluminación/fondo/postura/cámara.

export interface PhotoClassification {
  index: number;
  view: "lateral" | "frontal" | "posterior" | "unclear";
  valid: boolean;
  invalidReason: string | null;
  // Independencia de vistas (2026-09-01) — id estable de la foto que
  // produjo ESTA clasificación (MediaAsset.id, ver CatalogMediaItem.id en
  // types.ts). undefined en filas legado (analizadas antes de este
  // campo) o si el análisis vino del fallback on-device (nunca tuvo
  // acceso al id del servidor) — el cliente cae a la correlación por
  // posición en esos casos, ver PhotoClassification.swift.
  assetId?: string;
}

export function buildPrompt(opts: { hipNumber: string; horseName?: string; photoCount: number }): string {
  const horseLabel = opts.horseName ? ` (${opts.horseName})` : "";

  return `Sos un evaluador experto en anatomía y conformación equina, siguiendo la metodología RM Selection (Método RM) para yearlings Pura Sangre de carrera (Thoroughbred).

REGLA CENTRAL — MUY IMPORTANTE: tu tarea NO es juzgar parecido visual/fotográfico contra las imágenes del caballo referente (no compares belleza, color, pelaje, musculatura aparente por iluminación, tamaño en la foto, fondo, postura estética, calidad de cámara, ni semejanza superficial de la silueta). El caballo referente representa un PATRÓN ANATÓMICO Y DE CONFORMACIÓN, no una fotografía que haya que imitar. Debés construir mentalmente una representación estructural del referente a partir de sus 3 fotos (landmarks anatómicos, ejes corporales, proporciones entre segmentos, relaciones entre articulaciones, alineación de extremidades, línea superior, equilibrio, simetría) y comparar esa ESTRUCTURA contra la estructura del Hip evaluado — ESTRUCTURA vs. ESTRUCTURA, nunca FOTO vs. FOTO. Dos caballos pueden ser de color/tamaño/musculatura muy distintos y tener relaciones anatómicas igualmente correctas.

TOLERANCIA ANATÓMICA PROFESIONAL: una diferencia respecto al referente NO es automáticamente un defecto. El referente establece el estándar estructural pero no es un molde exacto — determiná primero si la diferencia permanece dentro de un rango anatómicamente correcto y funcional para un Thoroughbred atlético antes de penalizarla. Penalizá principalmente las desviaciones con verdadera relevancia conformacional o funcional; no castigues variaciones anatómicas normales solo por no ser idénticas al referente. Un caballo anatómicamente excelente puede recibir un puntaje muy alto aunque sus medidas individuales no sean idénticas a las del referente — no exijas identidad matemática absoluta.

=== PASO 1 — CLASIFICAR Y VALIDAR CADA FOTO DEL HIP ===
Te voy a mostrar ${opts.photoCount} foto(s) del Hip ${opts.hipNumber}${horseLabel}, en un orden que no necesariamente corresponde a LATERAL/FRONTAL/POSTERIOR — el usuario las pudo haber tomado en cualquier orden. Para CADA foto (identificada por su número de orden, empezando en 1), determiná:
1. Qué vista representa: "lateral" (de costado, se ve el perfil completo), "frontal" (de frente, mirando directamente hacia la cámara), "posterior" (de atrás, mirando la grupa/cuartos traseros), o "unclear" si no corresponde claramente a ninguna de esas 3 vistas o el caballo no es claramente identificable.
2. Si es una foto VÁLIDA para evaluación anatómica confiable de esa vista: considerá rotación del caballo respecto a la cámara, inclinación, perspectiva, distancia, posición de las extremidades, obstrucciones, encuadre, y si los landmarks anatómicos relevantes son visibles. Si la perspectiva permite compensación razonable, tratala como válida. Si la distorsión/posición impide una evaluación confiable, marcala inválida — NO inventes medidas ni penalices al caballo por una mala fotografía, simplemente marcala inválida con el motivo.
Si dos o más fotos parecen corresponder a la misma vista, elegí la MEJOR (más válida/más clara) para esa vista y marcá las demás como esa misma vista igual (no las descartes como "unclear", pero solo la mejor cuenta para el puntaje).

=== PASO 2 — ANALIZAR CADA VISTA VÁLIDA CONTRA EL PATRÓN ANATÓMICO DEL REFERENTE ===
Para cada vista (LATERAL/FRONTAL/POSTERIOR) que tenga al menos una foto del Hip válida y clasificada, comparar su estructura anatómica contra la vista correspondiente del caballo referente (adjunta más abajo, etiquetada) y asignar un puntaje de 0.0 a 10.0 a cada uno de sus 3 parámetros (ver lista exacta abajo). Si una vista NO tiene ninguna foto válida del Hip (falta la foto, o la única disponible fue marcada inválida), asigná 0.0 a sus 3 parámetros — NO inventes un puntaje sin una foto confiable de esa vista.

VISTA LATERAL — evaluar:
- lateral.proportions (Proporciones corporales): relación cabeza/cuello, longitud e inserción del cuello, cuello/hombro, profundidad de tórax, longitud corporal, relación tronco/extremidades, posición de la cruz, equilibrio entre tercio anterior/medio/posterior.
- lateral.topline (Línea superior): relaciones anatómicas y geométricas de cuello, inserción del cuello, cruz, hombro, dorso, lomo, unión lumbosacra, grupa (longitud e inclinación) — NO si la silueta "se parece", sino las relaciones estructurales.
- lateral.structure (Conformación estructural): ángulo escapular, relación hombro-brazo, rodilla, metacarpo, menudillo, cuartilla, casco anteriores; pelvis, cadera, articulación femorotibiorrotuliana, corvejón, metatarso, cuartilla y casco posteriores — la relación ENTRE segmentos, no cada región aislada.

VISTA FRONTAL — evaluar:
- frontal.alignment (Aplomo frontal): ejes anatómicos verticales — relación entre pecho, hombros, antebrazos, rodillas, cañas, menudillos, cuartillas, cascos; desviaciones mediales o laterales anatómicamente relevantes.
- frontal.symmetry (Simetría): lado izquierdo vs. derecho en hombros, pecho, extremidades anteriores, rodillas, menudillos, cascos — distinguí una asimetría anatómica real de una diferencia producida solo porque el caballo no está perfectamente alineado frente a la cámara.
- frontal.proportions (Proporciones frontales): amplitud del pecho, separación y orientación de las extremidades, relación tórax/extremidades, orientación de rodillas y cascos, equilibrio general del tren anterior.

VISTA POSTERIOR — evaluar:
- posterior.alignment (Aplomo posterior): ejes anatómicos de ambas extremidades posteriores — pelvis, cadera, muslo, articulación femorotibiorrotuliana, pierna, corvejones, cañas, menudillos, cuartillas, cascos.
- posterior.structure (Ángulos y estructura posterior): relaciones anatómicas entre pelvis, muslo, pierna, corvejón, metatarso — NO uses el volumen muscular como sustituto de una correcta estructura ósea (la musculatura es información complementaria, nunca reemplaza la evaluación estructural).
- posterior.symmetry (Simetría posterior): ambos lados de la grupa, pelvis, posición de corvejones, orientación de cañas, menudillos, cuartillas, cascos.

CASO ESPECIAL: si concluís que una foto del Hip muestra literalmente al MISMO caballo que el referente (misma capa, mismas marcas/lucero/calcetines, misma conformación individual), asignale 10.0 a los 3 parámetros de esa vista.

=== PASO 3 — RESUMEN ===
Escribí un resumen breve (2-4 oraciones) en español, con terminología profesional de anatomía y conformación equina, explicando los hallazgos anatómicos relevantes (proporciones, ejes, ángulos, alineación, simetría) — NO te limites a decir cuánto se parece el caballo al referente.

Respondé ÚNICAMENTE con un objeto JSON, sin texto adicional ni explicación, con esta forma exacta:
{
  "photos": [
    {"index": 1, "view": "lateral", "valid": true, "invalidReason": null},
    {"index": 2, "view": "frontal", "valid": false, "invalidReason": "rotación excesiva del caballo respecto a la cámara"}
  ],
  "scores": {"lateral.proportions": 0.0, "lateral.topline": 0.0, "lateral.structure": 0.0, "frontal.alignment": 0.0, "frontal.symmetry": 0.0, "frontal.proportions": 0.0, "posterior.alignment": 0.0, "posterior.structure": 0.0, "posterior.symmetry": 0.0},
  "summary": "texto del resumen"
}
El array "photos" debe tener exactamente ${opts.photoCount} elemento(s), uno por cada foto del Hip en el mismo orden en que te las mostré (index 1 = primera foto, etc.). El objeto "scores" debe tener EXACTAMENTE esas 9 claves, valores numéricos con un decimal.`;
}

interface RawAnalysisResponse {
  photos?: Array<{ index?: unknown; view?: unknown; valid?: unknown; invalidReason?: unknown }>;
  scores?: Record<string, unknown>;
  summary?: unknown;
}

export interface ParsedAnalysisResponse {
  photos: PhotoClassification[];
  scores: Record<string, number>;
  summary: string | null;
}

const VALID_VIEWS = new Set(["lateral", "frontal", "posterior", "unclear"]);

export function extractAnalysisResponse(text: string): ParsedAnalysisResponse | null {
  let cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  let raw: RawAnalysisResponse;
  try {
    raw = JSON.parse(cleaned) as RawAnalysisResponse;
  } catch {
    return null;
  }

  const scores: Record<string, number> = {};
  if (raw.scores && typeof raw.scores === "object") {
    for (const [key, value] of Object.entries(raw.scores)) {
      if (typeof value === "number") scores[key] = value;
    }
  }
  if (Object.keys(scores).length === 0) return null;

  const photos: PhotoClassification[] = [];
  if (Array.isArray(raw.photos)) {
    for (const p of raw.photos) {
      const index = typeof p.index === "number" ? p.index : photos.length + 1;
      const view = typeof p.view === "string" && VALID_VIEWS.has(p.view) ? (p.view as PhotoClassification["view"]) : "unclear";
      const valid = typeof p.valid === "boolean" ? p.valid : false;
      const invalidReason = typeof p.invalidReason === "string" ? p.invalidReason : null;
      photos.push({ index, view, valid, invalidReason });
    }
  }

  const summary = typeof raw.summary === "string" ? raw.summary : null;

  return { photos, scores, summary };
}
