// Conformation Knowledge Base — pieza (B) del motor RM de Análisis
// Anatómico. Biblioteca profesional de defectos de conformación/aplomos,
// estructurada para que el motor pueda razonar POR QUÉ existe una
// desviación, no solo detectar "se parece poco al referente".
//
// Terminología validada contra fuentes profesionales de conformación
// equina (Kentucky Equine Research, AQHA, University of Georgia
// Extension, University of Minnesota Extension, Mad Barn, entre otras) —
// ver investigación 2026-08-14 adjunta al reporte de esta tarea.
//
// Cada entrada documenta los 12 campos pedidos explícitamente:
// ID, nombre EN, nombre ES, vista óptima, landmarks necesarios, eje/ángulo
// esperado, dirección de desviación, tolerancia (configurable — ver punto
// 7 de las instrucciones: "no fijar umbrales arbitrarios"), bandas de
// severidad, factor de confianza, peso RM, relaciones con otros defectos,
// reglas anti doble-penalización.
//
// `rmPriority: true` marca los 9 criterios prioritarios que Ramon definió
// explícitamente (F1–F3, L1–L4, P1–P2) — son los que compiten por espacio
// en la pantalla final. Las entradas con `rmPriority: false` son
// conocimiento interno (biblioteca más amplia, punto 6 de las
// instrucciones) que el motor usa para clasificar correctamente pero que
// NO se muestran al usuario sin autorización explícita (punto 14).

export type ToleranceUnit = "normalizedOffset" | "degrees" | "ratio";

/**
 * Bandas de severidad configurables — NO hardcodeadas como "más de 5
 * grados = defecto" (punto 7 de las instrucciones). Cada defecto define
 * su propio punto de partida ("dentro de tolerancia"), y a partir de ahí
 * 3 escalones de severidad. Los valores acá son un PRIMER calibrado,
 * derivado de rangos profesionales de referencia y del sentido común
 * biomecánico de cada defecto — están pensados para recalibrarse con
 * datos reales de RM Selection sin tocar el motor (ver severity.ts, que
 * solo LEE esta estructura, nunca tiene números propios).
 */
export interface ToleranceBands {
  unit: ToleranceUnit;
  /** Por debajo de este valor: "Correct" / dentro de tolerancia. */
  correctoMax: number;
  /** Por debajo de este valor (y por encima de correctoMax): Leve. */
  leveMax: number;
  /** Por debajo de este valor (y por encima de leveMax): Moderado. Por encima: Marcado. */
  moderadoMax: number;
}

export interface ConformationDefect {
  id: string;
  nameEn: string;
  nameEs: string;
  /** Vista óptima para detectarlo — puede requerir más de una si el defecto tiene manifestaciones en varias vistas (se marca la principal). */
  view: "frontal" | "lateral" | "posterior";
  /** IDs de landmarks (ver landmarks.ts) que la medición de este defecto necesita, EN ORDEN de la cadena anatómica relevante — puramente documental (las reglas en rmPriorityRules.ts son la fuente ejecutable). */
  landmarks: string[];
  /** Descripción breve del eje o ángulo que se espera en un caballo correcto. */
  expectedAxis: string;
  /** Dirección de la desviación que este defecto representa (medial/lateral/craneal/caudal/etc.), en lenguaje llano. */
  deviationDirection: string;
  tolerance: ToleranceBands;
  /**
   * Peso RM (0–1): cuánto pesa este defecto en el score determinístico y
   * en la prioridad de selección de hallazgos — refleja la importancia
   * relativa que Ramon le da como comprador, NO la gravedad veterinaria
   * en abstracto. Los 9 criterios prioritarios llevan el peso más alto.
   */
  rmWeight: number;
  rmPriority: boolean;
  /** IDs de otros defectos anatómicamente relacionados (misma causa raíz posible, o extremos opuestos de la misma escala). */
  relatedDefectIds: string[];
  /** Regla en lenguaje llano de cómo evitar doble penalización con sus relacionados — ver findingsPrioritizer.ts para la implementación. */
  doubleCountingRule: string;
}

export const CONFORMATION_KNOWLEDGE_BASE: ConformationDefect[] = [
  // ============================================================
  // FRONTAL — familia de desviación medial/lateral. Un mismo patrón
  // visual (extremidad "hacia adentro" o "hacia afuera") puede originarse
  // en 3 lugares distintos de la cadena anatómica — el motor determina
  // CUÁL, midiendo en qué segmento aparece la mayor desviación relativa:
  // pecho→carpo (base-narrow/wide), carpo→menudillo (carpal valgus/
  // varus/rotación), menudillo→casco (toe-in/toe-out como orientación
  // pura del casco).
  // ============================================================
  {
    id: "base_narrow",
    nameEn: "Base-narrow",
    nameEs: "Base estrecha",
    view: "frontal",
    // carpusLeft/Right y fetlockLeft/Right agregados 2026-08-14 (corrección
    // de estabilidad): la referencia proximal ahora promedia hombro+carpo+
    // menudillo cuando están disponibles, en vez de depender únicamente
    // del par hombro-hombro — ver comentario largo en rmPriorityRules.ts.
    landmarks: ["chestCenter", "shoulderLeft", "shoulderRight", "carpusLeft", "carpusRight", "fetlockLeft", "fetlockRight", "hoofCenterLeft", "hoofCenterRight"],
    expectedAxis: "Ancho entre cascos ≈ ancho promedio de la extremidad entre el nacimiento en el pecho y el menudillo.",
    deviationDirection: "Cascos más juntos entre sí que el nacimiento de los miembros en el pecho.",
    tolerance: { unit: "ratio", correctoMax: 0.08, leveMax: 0.16, moderadoMax: 0.28 },
    rmWeight: 0.85,
    rmPriority: true, // manifestación de F1
    relatedDefectIds: ["toe_in", "carpus_valgus"],
    doubleCountingRule:
      "Si base_narrow es el origen dominante (mayor desviación relativa en el segmento pecho→carpo), no reportar carpus_valgus ni toe_in por separado en la misma extremidad salvo que el casco tenga una orientación adicional que el offset proximal no explique.",
  },
  {
    id: "base_wide",
    nameEn: "Base-wide",
    nameEs: "Base ancha",
    view: "frontal",
    // Ver nota en base_narrow (mismo cambio 2026-08-14).
    landmarks: ["chestCenter", "shoulderLeft", "shoulderRight", "carpusLeft", "carpusRight", "fetlockLeft", "fetlockRight", "hoofCenterLeft", "hoofCenterRight"],
    expectedAxis: "Ancho entre cascos ≈ ancho promedio de la extremidad entre el nacimiento en el pecho y el menudillo.",
    deviationDirection: "Cascos más separados entre sí que el nacimiento de los miembros en el pecho.",
    tolerance: { unit: "ratio", correctoMax: 0.08, leveMax: 0.16, moderadoMax: 0.28 },
    rmWeight: 0.85,
    rmPriority: true, // manifestación de F2
    relatedDefectIds: ["toe_out", "carpus_varus"],
    doubleCountingRule:
      "Si base_wide es el origen dominante, no reportar carpus_varus ni toe_out por separado en la misma extremidad salvo orientación adicional del casco no explicada por el offset proximal.",
  },
  {
    id: "carpus_valgus",
    nameEn: "Carpal valgus (knock-kneed)",
    nameEs: "Desviación medial del carpo (rodillas juntas)",
    view: "frontal",
    landmarks: ["carpusLeft", "carpusRight", "shoulderLeft", "shoulderRight", "hoofCenterLeft", "hoofCenterRight"],
    expectedAxis: "El carpo se ubica sobre la línea recta hombro→casco de su propia extremidad.",
    deviationDirection: "El carpo se desvía hacia la línea media (medial) respecto al eje hombro-casco.",
    tolerance: { unit: "normalizedOffset", correctoMax: 0.03, leveMax: 0.06, moderadoMax: 0.1 },
    rmWeight: 0.8,
    rmPriority: true, // manifestación de F1
    relatedDefectIds: ["base_narrow", "toe_in"],
    doubleCountingRule:
      "Reportar solo si el offset del carpo respecto al eje hombro-casco es el mayor de los 3 segmentos evaluados (pecho, carpo, casco). Si el casco tiene además una rotación propia adicional y significativa, se agrupan como un único hallazgo 'toe-in / desviación medial' con el segmento de origen indicado.",
  },
  {
    id: "carpus_varus",
    nameEn: "Carpal varus (bow-legged)",
    nameEs: "Desviación lateral del carpo (rodillas separadas)",
    view: "frontal",
    landmarks: ["carpusLeft", "carpusRight", "shoulderLeft", "shoulderRight", "hoofCenterLeft", "hoofCenterRight"],
    expectedAxis: "El carpo se ubica sobre la línea recta hombro→casco de su propia extremidad.",
    deviationDirection: "El carpo se desvía hacia afuera (lateral) respecto al eje hombro-casco.",
    tolerance: { unit: "normalizedOffset", correctoMax: 0.03, leveMax: 0.06, moderadoMax: 0.1 },
    rmWeight: 0.8,
    rmPriority: true, // manifestación de F2
    relatedDefectIds: ["base_wide", "toe_out"],
    doubleCountingRule: "Mismo criterio que carpus_valgus, en la dirección opuesta.",
  },
  {
    id: "toe_in",
    nameEn: "Toe-in",
    nameEs: "Casco desviado hacia adentro",
    view: "frontal",
    landmarks: ["fetlockLeft", "hoofToeLeft", "hoofHeelLeft", "fetlockRight", "hoofToeRight", "hoofHeelRight"],
    expectedAxis: "El eje talón-punta del casco es paralelo al plano sagital del caballo (el casco 'mira' derecho hacia adelante).",
    deviationDirection: "La punta del casco rota hacia la línea media.",
    tolerance: { unit: "degrees", correctoMax: 5, leveMax: 10, moderadoMax: 18 },
    rmWeight: 0.9,
    rmPriority: true, // F1
    relatedDefectIds: ["base_narrow", "carpus_valgus"],
    doubleCountingRule:
      "Se mide como la rotación del casco NO explicada por el offset proximal (pecho/carpo) ya contabilizado en base_narrow/carpus_valgus — evita sumar dos veces la misma desviación medial vista en distintos segmentos.",
  },
  {
    id: "toe_out",
    nameEn: "Toe-out",
    nameEs: "Casco desviado hacia afuera",
    view: "frontal",
    landmarks: ["fetlockLeft", "hoofToeLeft", "hoofHeelLeft", "fetlockRight", "hoofToeRight", "hoofHeelRight"],
    expectedAxis: "El eje talón-punta del casco es paralelo al plano sagital del caballo.",
    deviationDirection: "La punta del casco rota hacia afuera de la línea media.",
    tolerance: { unit: "degrees", correctoMax: 5, leveMax: 10, moderadoMax: 18 },
    rmWeight: 0.9,
    rmPriority: true, // F2
    relatedDefectIds: ["base_wide", "carpus_varus"],
    doubleCountingRule: "Mismo criterio que toe_in, en la dirección opuesta.",
  },
  {
    id: "hoof_asymmetry",
    nameEn: "Hoof asymmetry",
    nameEs: "Asimetría de cascos",
    view: "frontal",
    landmarks: ["hoofMedialLeft", "hoofLateralLeft", "hoofToeLeft", "hoofHeelLeft", "hoofMedialRight", "hoofLateralRight", "hoofToeRight", "hoofHeelRight"],
    expectedAxis: "Ancho y altura aparente del casco izquierdo ≈ derecho, proporcional al grosor de la caña de cada extremidad.",
    deviationDirection: "Un casco (ancho x alto) claramente menor o de forma distinta al contralateral.",
    tolerance: { unit: "ratio", correctoMax: 0.06, leveMax: 0.12, moderadoMax: 0.22 },
    rmWeight: 0.75,
    rmPriority: true, // F3
    relatedDefectIds: [],
    doubleCountingRule: "Hallazgo independiente — no se agrupa con toe-in/toe-out ni con base-narrow/wide (son ejes distintos: orientación vs. tamaño/forma).",
  },

  // ============================================================
  // LATERAL — miembro anterior (perfil).
  // ============================================================
  {
    id: "over_at_the_knee",
    nameEn: "Over at the knee (buck-kneed)",
    nameEs: "Rodilla adelantada (buck-kneed)",
    view: "lateral",
    landmarks: ["elbow", "carpus", "fetlockFront"],
    expectedAxis: "El carpo cae sobre la línea recta codo→menudillo.",
    deviationDirection: "El carpo se adelanta (craneal) respecto a esa línea.",
    tolerance: { unit: "normalizedOffset", correctoMax: 0.025, leveMax: 0.05, moderadoMax: 0.09 },
    rmWeight: 0.85,
    rmPriority: true, // L1
    relatedDefectIds: ["calf_kneed"],
    doubleCountingRule: "Hallazgo único por extremidad — no coexiste con calf_kneed (son direcciones opuestas de la misma medición).",
  },
  {
    id: "calf_kneed",
    nameEn: "Calf-kneed (back at the knee)",
    nameEs: "Rodilla retrasada (calf-kneed)",
    view: "lateral",
    landmarks: ["elbow", "carpus", "fetlockFront"],
    expectedAxis: "El carpo cae sobre la línea recta codo→menudillo.",
    deviationDirection: "El carpo se retrasa (caudal) respecto a esa línea — dirección opuesta a over_at_the_knee.",
    tolerance: { unit: "normalizedOffset", correctoMax: 0.025, leveMax: 0.05, moderadoMax: 0.09 },
    rmWeight: 0.7,
    rmPriority: false, // no listado como criterio RM explícito, pero el motor debe conocerlo (punto 14/L1)
    relatedDefectIds: ["over_at_the_knee"],
    doubleCountingRule: "Mismo criterio que over_at_the_knee, dirección opuesta.",
  },
  {
    id: "upright_pastern",
    nameEn: "Upright pastern",
    nameEs: "Cuartilla vertical/corta",
    view: "lateral",
    landmarks: ["fetlockFront", "coronetFront", "hoofToeFront", "hoofHeelFront"],
    expectedAxis: "Ángulo cuartilla-suelo entre 45° y 50° (eje casco-cuartilla continuo, ver hoof_pastern_axis_broken).",
    deviationDirection: "Ángulo mayor al rango esperado (cuartilla demasiado parada) — aumenta la concusión.",
    tolerance: { unit: "degrees", correctoMax: 6, leveMax: 12, moderadoMax: 20 },
    rmWeight: 0.75,
    rmPriority: true, // L2
    relatedDefectIds: ["hoof_pastern_axis_broken", "excessively_vertical_leg"],
    doubleCountingRule:
      "Si además hoof_pastern_axis_broken está presente en la misma extremidad con quiebre hacia adelante, agrupar como un único hallazgo (el ángulo de cuartilla y el quiebre del eje comparten la misma causa estructural en ese caso).",
  },
  {
    id: "long_sloping_pastern",
    nameEn: "Long/sloping pastern",
    nameEs: "Cuartilla larga/inclinada",
    view: "lateral",
    landmarks: ["fetlockFront", "coronetFront", "hoofToeFront", "hoofHeelFront", "cannonMidFront"],
    expectedAxis: "Longitud de cuartilla proporcional a la caña; ángulo cuartilla-suelo entre 45°–50°.",
    deviationDirection: "Cuartilla desproporcionadamente larga y/o ángulo por debajo del rango esperado (demasiado horizontal).",
    tolerance: { unit: "degrees", correctoMax: 6, leveMax: 12, moderadoMax: 20 },
    rmWeight: 0.75,
    rmPriority: true, // L3
    relatedDefectIds: ["hoof_pastern_axis_broken"],
    doubleCountingRule:
      "Si hoof_pastern_axis_broken está presente con quiebre hacia atrás en la misma extremidad, agrupar como un único hallazgo.",
  },
  {
    id: "hoof_pastern_axis_broken",
    nameEn: "Broken hoof-pastern axis",
    nameEs: "Eje casco-cuartilla quebrado",
    view: "lateral",
    landmarks: ["coronetFront", "hoofToeFront", "hoofHeelFront", "fetlockFront", "pasternMidFront"],
    expectedAxis: "La línea cuartilla y la línea de la pared del casco forman una sola línea continua (sin quiebre) vistas de perfil.",
    deviationDirection: "Discontinuidad entre el ángulo de la cuartilla y el ángulo de la pared del casco (quiebre hacia adelante o hacia atrás).",
    tolerance: { unit: "degrees", correctoMax: 4, leveMax: 8, moderadoMax: 14 },
    rmWeight: 0.6,
    rmPriority: false, // conocimiento interno de apoyo a L2/L3
    relatedDefectIds: ["upright_pastern", "long_sloping_pastern"],
    doubleCountingRule: "Ver reglas de upright_pastern y long_sloping_pastern — nunca se muestra como hallazgo independiente además de esos dos.",
  },
  {
    id: "excessively_vertical_leg",
    nameEn: "Excessively upright forelimb",
    nameEs: "Extremidad anterior excesivamente vertical",
    view: "lateral",
    landmarks: ["carpus", "cannonMidFront", "fetlockFront", "coronetFront"],
    expectedAxis: "Ligera inclinación natural de la caña dentro de un rango normal; no perfectamente vertical rígida en toda la extremidad.",
    deviationDirection: "Toda la extremidad (no solo la cuartilla) presenta una postura anormalmente vertical/rígida.",
    tolerance: { unit: "degrees", correctoMax: 5, leveMax: 10, moderadoMax: 16 },
    rmWeight: 0.55,
    rmPriority: true, // L2 (catch-all cuando la causa es postural general y no solo la cuartilla)
    relatedDefectIds: ["upright_pastern"],
    doubleCountingRule:
      "Se reporta como hallazgo separado de upright_pastern SOLO si la verticalidad involucra caña+cuartilla+casco en conjunto, no únicamente la cuartilla (si es solo la cuartilla, ya lo cubre upright_pastern).",
  },

  // Lateral — miembro posterior.
  {
    id: "sickle_hocked",
    nameEn: "Sickle-hocked",
    nameEs: "Corvejón de hoz (sickle-hocked)",
    view: "lateral",
    landmarks: ["pointOfButtock", "hock", "fetlockHind", "stifle"],
    expectedAxis: "Línea vertical desde la punta de la nalga (point of buttock) hasta el suelo pasa cerca del talón del casco posterior; ángulo del corvejón dentro de rango normal.",
    deviationDirection: "El corvejón (y la caña desde ahí para abajo) se adelanta bajo el cuerpo con un ángulo de corvejón excesivo.",
    tolerance: { unit: "degrees", correctoMax: 6, leveMax: 12, moderadoMax: 20 },
    rmWeight: 0.85,
    rmPriority: true, // L4
    relatedDefectIds: ["post_legged", "camped_under"],
    doubleCountingRule:
      "Mutuamente excluyente con post_legged, camped_under y camped_out en la misma extremidad — el motor determina UN patrón dominante por extremidad a partir de (a) offset del corvejón respecto a la línea de plomada y (b) ángulo del corvejón.",
  },
  {
    id: "post_legged",
    nameEn: "Post-legged (straight behind)",
    nameEs: "Corvejón recto (post-legged)",
    view: "lateral",
    landmarks: ["pointOfButtock", "hock", "fetlockHind", "stifle"],
    expectedAxis: "Mismo eje que sickle_hocked — ángulo del corvejón dentro de rango normal.",
    deviationDirection: "Ángulo del corvejón insuficiente (extremidad casi recta) — extremo opuesto a sickle_hocked.",
    tolerance: { unit: "degrees", correctoMax: 6, leveMax: 12, moderadoMax: 20 },
    rmWeight: 0.8,
    rmPriority: true, // L4
    relatedDefectIds: ["sickle_hocked"],
    doubleCountingRule: "Ver sickle_hocked — mismo grupo mutuamente excluyente.",
  },
  {
    id: "camped_under",
    nameEn: "Camped-under",
    nameEs: "Extremidad posterior adelantada (camped-under)",
    view: "lateral",
    landmarks: ["pointOfButtock", "hock", "fetlockHind", "hoofToeHind", "hoofHeelHind"],
    expectedAxis: "Línea vertical desde la punta de la nalga hasta el suelo pasa cerca del talón del casco posterior.",
    deviationDirection: "TODA la extremidad (no solo el corvejón) se ubica adelantada respecto a esa línea de plomada.",
    tolerance: { unit: "normalizedOffset", correctoMax: 0.03, leveMax: 0.06, moderadoMax: 0.1 },
    rmWeight: 0.75,
    rmPriority: true, // L4
    relatedDefectIds: ["sickle_hocked"],
    doubleCountingRule: "Ver sickle_hocked — mismo grupo mutuamente excluyente (se diferencia de sickle_hocked porque el offset es proximal, de toda la pierna, no solo un ángulo de corvejón excesivo).",
  },
  {
    id: "camped_out",
    nameEn: "Camped-out",
    nameEs: "Extremidad posterior retrasada (camped-out)",
    view: "lateral",
    landmarks: ["pointOfButtock", "hock", "fetlockHind", "hoofToeHind", "hoofHeelHind"],
    expectedAxis: "Línea vertical desde la punta de la nalga hasta el suelo pasa cerca del talón del casco posterior.",
    deviationDirection: "TODA la extremidad se ubica retrasada (caudal) respecto a esa línea — extremo opuesto a camped_under.",
    tolerance: { unit: "normalizedOffset", correctoMax: 0.03, leveMax: 0.06, moderadoMax: 0.1 },
    rmWeight: 0.7,
    rmPriority: true, // L4
    relatedDefectIds: ["camped_under", "post_legged"],
    doubleCountingRule: "Ver sickle_hocked/camped_under — mismo grupo mutuamente excluyente.",
  },

  // ============================================================
  // POSTERIOR — familia corvejones.
  // ============================================================
  {
    id: "cow_hocked",
    nameEn: "Cow-hocked",
    nameEs: "Corvejones cerrados (cow-hocked)",
    view: "posterior",
    landmarks: ["tuberCoxaeLeft", "tuberCoxaeRight", "hockLeft", "hockRight", "fetlockLeft", "fetlockRight"],
    expectedAxis: "Ancho entre corvejones ≈ ancho entre puntas de cadera ≈ ancho entre cascos (las 3 líneas aproximadamente paralelas).",
    deviationDirection: "Corvejones convergen hacia la línea media (más juntos que cadera y que cascos) mientras la porción distal tiende a separarse.",
    tolerance: { unit: "ratio", correctoMax: 0.08, leveMax: 0.16, moderadoMax: 0.28 },
    rmWeight: 0.85,
    rmPriority: true, // P1
    relatedDefectIds: ["bow_hocked"],
    doubleCountingRule: "Mutuamente excluyente con bow_hocked en el mismo caballo — un solo patrón dominante por el ancho relativo cadera/corvejón/casco.",
  },
  {
    id: "bow_hocked",
    nameEn: "Bow-hocked (bandy-hocked)",
    nameEs: "Corvejones abiertos (bow-hocked)",
    view: "posterior",
    landmarks: ["tuberCoxaeLeft", "tuberCoxaeRight", "hockLeft", "hockRight", "fetlockLeft", "fetlockRight"],
    expectedAxis: "Mismo eje que cow_hocked.",
    deviationDirection: "Corvejones más separados que cadera y que cascos — patrón opuesto a cow_hocked.",
    tolerance: { unit: "ratio", correctoMax: 0.08, leveMax: 0.16, moderadoMax: 0.28 },
    rmWeight: 0.75,
    rmPriority: true, // P2
    relatedDefectIds: ["cow_hocked"],
    doubleCountingRule: "Ver cow_hocked — mutuamente excluyentes.",
  },
];

export function findDefect(id: string): ConformationDefect | undefined {
  return CONFORMATION_KNOWLEDGE_BASE.find((d) => d.id === id);
}

export function defectsForView(view: "frontal" | "lateral" | "posterior"): ConformationDefect[] {
  return CONFORMATION_KNOWLEDGE_BASE.filter((d) => d.view === view);
}
