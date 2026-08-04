// Puerto directo del prompt de RMSelection/Services/AIConformationScoringService.swift
// (buildPrompt) — mismo texto, misma regla central de comparación contra
// el caballo referente, mismos 26 ids exactos.

export function buildPrompt(opts: {
  hipNumber: string;
  horseName?: string;
  includesHipVideoFrames: boolean;
  includesReferenceGaitFrames: boolean;
}): string {
  const horseLabel = opts.horseName ? ` (${opts.horseName})` : "";

  let videoNote: string;
  if (opts.includesHipVideoFrames) {
    videoNote = opts.includesReferenceGaitFrames
      ? "\n\nMás abajo vas a ver DOS tandas de fotogramas de marcha: primero los del CABALLO REFERENTE (su recorrido completo caminando/trotando, de punta a punta) y después los del HIP A EVALUAR (también de punta a punta). Usalos para evaluar las 7 subcategorías de Marcha (gait.*) comparando el movimiento real del Hip contra el movimiento real del referente — no contra una idea abstracta de \"buena marcha\"."
      : "\n\nMás abajo vas a ver los fotogramas de marcha del HIP A EVALUAR, cubriendo su recorrido completo caminando/trotando de punta a punta. No hay fotogramas de marcha del caballo referente disponibles todavía, así que para las 7 subcategorías de Marcha (gait.*) evalualas usando tu criterio experto sobre lo que se considera una marcha correcta en la raza, aclarando en tu evaluación interna que es una estimación menos precisa que si hubiera video del referente.";
  } else {
    videoNote =
      "\n\nNo hay video de este Hip en movimiento, solo fotos fijas. NO evalúes ni inventes las subcategorías de Marcha (gait.*) a partir de una pose estática — para esas 7 claves devolvé directamente 0.0, ya que la marcha real no se puede determinar sin video.";
  }

  return `Sos un evaluador experto en conformación de yearlings Pura Sangre de carrera (Thoroughbred), siguiendo la metodología RM Selection (Método RM).

REGLA CENTRAL — MUY IMPORTANTE: tu evaluación NO es contra un estándar genérico de conformación equina ni contra tu idea abstracta de "caballo ideal". Es una comparación de SIMILITUD contra el CABALLO REFERENTE cuyas fotos (y, si están disponibles, fotogramas de marcha) te adjunto más abajo — ese ejemplar es el patrón oficial calibrado del Método RM. El puntaje de cada subcategoría (0.0 a 10.0) representa qué tan parecido es el Hip evaluado al caballo referente en ese aspecto puntual: 10.0 = equivalente al referente, 0.0 = máxima diferencia respecto al referente. Ignorá por completo cualquier noción general de "buena conformación" que no esté anclada en las fotos del referente que te adjunto: la única base de comparación válida es esa, no un criterio genérico de la raza.

CASO ESPECIAL: si al mirar las fotos del Hip a evaluar concluís que se trata del MISMO caballo que el referente (misma capa, mismas marcas/lucero/calcetines, misma conformación individual — no solo un caballo parecido, sino el mismo ejemplar), asignale 10.0 a todas las subcategorías que puedas evaluar con las imágenes disponibles (incluida Marcha si hay fotogramas de ambos). Por definición, el caballo referente comparado contra sí mismo tiene 100% de similitud.

Analizá las imágenes adjuntas del Hip ${opts.hipNumber}${horseLabel} y asigná un puntaje de 0.0 a 10.0 a cada una de las 26 subcategorías listadas abajo.${videoNote}

ANÁLISIS DE MARCHA — EXHAUSTIVO: cuando haya fotogramas de video, tratalos como una secuencia continua que cubre el recorrido COMPLETO del clip, desde que el caballo arranca a caminar hasta el último fotograma — no te bases en una sola imagen aislada ni ignores ninguna parte de la secuencia. Con esa secuencia completa evaluá en conjunto: biomecánica general, desplazamiento, longitud y calidad de la zancada, coordinación entre miembros, ritmo, balance, aplomos en movimiento (cómo se mueven las extremidades respecto a como se ven paradas en las fotos fijas), movimiento de cabeza/cuello/dorso, impulsión de los posteriores, simetría entre el lado izquierdo y derecho, fluidez general del movimiento, y cualquier otro detalle relevante para el Método RM que se note a lo largo de toda la secuencia (irregularidades puntuales, cojeras leves, tensión, naturalidad del movimiento, etc.). Tu puntaje de cada subcategoría de Marcha debe reflejar ese análisis del recorrido entero, no una instantánea suelta.

Subcategorías (usá EXACTAMENTE estos ids como claves):
Anatomía funcional: functional.head (cabeza), functional.neck (cuello), functional.shoulder (hombro), functional.withers (cruz), functional.back (dorso), functional.loin (lomo), functional.croup (grupa), functional.hip (cadera), functional.muscling (musculatura), functional.chest (pecho), functional.topline (línea superior), functional.underline (línea inferior).
Aplomos: limb.forelimbs (miembros anteriores), limb.hindlimbs (miembros posteriores), limb.knees (rodillas), limb.hocks (corvejones), limb.fetlocks (menudillos), limb.pasterns (cuartillas), limb.hooves (cascos).
Marcha: gait.tracking (desplazamiento), gait.balance (balance), gait.strideLength (longitud y calidad de zancada), gait.impulsion (impulsión de los posteriores), gait.coordination (coordinación), gait.rhythm (ritmo), gait.symmetry (simetría y fluidez del movimiento).

Respondé ÚNICAMENTE con un objeto JSON plano, sin texto adicional ni explicación, con esta forma exacta (las 26 claves, valores numéricos con un decimal):
{"functional.head": 0.0, "functional.neck": 0.0, "functional.shoulder": 0.0, "functional.withers": 0.0, "functional.back": 0.0, "functional.loin": 0.0, "functional.croup": 0.0, "functional.hip": 0.0, "functional.muscling": 0.0, "functional.chest": 0.0, "functional.topline": 0.0, "functional.underline": 0.0, "limb.forelimbs": 0.0, "limb.hindlimbs": 0.0, "limb.knees": 0.0, "limb.hocks": 0.0, "limb.fetlocks": 0.0, "limb.pasterns": 0.0, "limb.hooves": 0.0, "gait.tracking": 0.0, "gait.balance": 0.0, "gait.strideLength": 0.0, "gait.impulsion": 0.0, "gait.coordination": 0.0, "gait.rhythm": 0.0, "gait.symmetry": 0.0}`;
}

export function extractScores(text: string): Record<string, number> | null {
  let cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  try {
    const raw = JSON.parse(cleaned) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number") result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
