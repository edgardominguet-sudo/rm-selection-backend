import { config } from "../config";
import { fetchAndDownscale } from "./imageDownscale";
import { ALL_TRAIT_IDS, ConformationScores, emptyScores, setScore, METHODOLOGY_VERSION } from "./conformationScores";
import { CatalogMediaItem } from "../types";
import { PhotoClassification } from "./prompt";
import { extractLandmarksFromPhoto } from "./landmarkVisionClient";
import { ViewLandmarks, ViewName } from "./landmarks";
import { evaluateFrontalFindings, evaluateLateralFindings, evaluatePosteriorFindings } from "./rmPriorityRules";
import { scoreView, ViewScore } from "./scoringEngine";
import { prioritizeFindings, DisplayFinding } from "./findingsPrioritizer";
import { getOrComputeReferenceCalibration } from "./referenceCalibration";
import { Finding } from "./findings";
import { findDefect } from "./conformationKnowledgeBase";

export class MissingReferenceHorseError extends Error {}
export class NoPhotosError extends Error {}
export class AIResponseError extends Error {}

// Patrón anatómico oficial (2026-08-13): EXACTAMENTE 3 fotos con rol fijo,
// una por vista — ver comentario en ReferenceHorse, schema.prisma. El
// campo `photoUrls`/`gaitVideoUrl` legado ya no se usa en este módulo.
export interface ReferenceHorseAssets {
  photoUrls: string[];
  gaitVideoUrl?: string | null;
  lateralPhotoUrl?: string | null;
  frontalPhotoUrl?: string | null;
  posteriorPhotoUrl?: string | null;
}

/** Landmarks + hallazgos + puntaje de UNA vista — lo que persiste ahora AnalysisResult además de los campos legado (ver rankingService.ts). */
export interface ViewAnalysisDetail {
  available: boolean;
  landmarks: ViewLandmarks | null;
  findings: Finding[];
  score: ViewScore | null;
  displayFindings: DisplayFinding[];
}

export interface AnalysisOutcome {
  scores: ConformationScores;
  photoClassifications: PhotoClassification[];
  summary: string | null;
  methodologyVersion: string;
  /** Detalle completo del motor nuevo, por vista — landmarks crudos, hallazgos, y qué se decidió mostrar. Se persiste tal cual en AnalysisResult.landmarksJson/findingsJson (ver rankingService.ts) para poder auditar CUALQUIER resultado pasado sin volver a llamar a la IA. */
  detail: Record<ViewName, ViewAnalysisDetail>;
  /**
   * Independencia de vistas (2026-09-01) — qué MediaAsset.id ganó cada
   * vista en ESTE análisis puntual (solo vistas con foto válida quedan
   * acá). `analyzeHipOnDemand` (rankingService.ts) guarda esto en
   * AnalysisResult.viewSourceAssetIdsJson y lo compara en el próximo
   * pedido: si el id de una vista no cambió, esa vista NUNCA vuelve a
   * pasar por este motor — se reusa el resultado anterior tal cual, sin
   * volver a llamar a la IA ni recalcular nada.
   */
  viewSourceAssetIds: Partial<Record<ViewName, string>>;
}

const VIEW_SUBKEYS: Record<ViewName, readonly string[]> = {
  frontal: ["alignment", "symmetry", "proportions"],
  lateral: ["proportions", "topline", "structure"],
  posterior: ["alignment", "structure", "symmetry"],
};

/**
 * Corre el análisis de conformación de un Hip contra el caballo referente
 * — MOTOR PROFESIONAL DE ANÁLISIS ANATÓMICO (2026-08-14): landmarks →
 * ejes → mediciones → comparación con tolerancias profesionales →
 * desviaciones → severidad → score determinístico → hallazgos
 * priorizados. Reemplaza la metodología anterior (2026-08-13, "pedirle a
 * la IA que puntúe 9 parámetros directamente") — ver
 * conformationKnowledgeBase.ts para el porqué de fondo.
 */
export async function analyzeHip(opts: {
  hipNumber: string;
  horseName?: string;
  organizationId: string;
  media: CatalogMediaItem[];
  reference: ReferenceHorseAssets;
}): Promise<AnalysisOutcome> {
  if (!config.anthropicApiKey) {
    throw new Error("Falta ANTHROPIC_API_KEY en la configuración del backend.");
  }
  if (!opts.reference.lateralPhotoUrl || !opts.reference.frontalPhotoUrl || !opts.reference.posteriorPhotoUrl) {
    throw new MissingReferenceHorseError(
      "Falta configurar las 3 fotos del caballo referente (lateral, frontal, posterior)."
    );
  }

  const photoItems = opts.media.filter((m) => m.kind === "photo").slice(0, 6);
  if (photoItems.length === 0) {
    throw new NoPhotosError("Este Hip todavía no tiene fotos cargadas para analizar.");
  }

  // Paso 1 — calibración del referente (cacheada, ver referenceCalibration.ts).
  const calibration = await getOrComputeReferenceCalibration(opts.organizationId, opts.reference);
  if (!calibration) {
    throw new MissingReferenceHorseError("No se pudo calibrar el caballo referente (no se pudieron leer sus 3 fotos).");
  }

  // Paso 2 — extraer landmarks de cada foto del Hip (clasificación de
  // vista incluida, igual que el prompt legado hacía en su Paso 1).
  const photoClassifications: PhotoClassification[] = [];
  type PhotoResult = { index: number; view: ViewName | "unclear"; valid: boolean; landmarks: ViewLandmarks; overallConfidence: number; assetId?: string };
  const results: PhotoResult[] = [];

  for (let i = 0; i < photoItems.length; i++) {
    const item = photoItems[i];
    const jpeg = await fetchAndDownscale(item.url);
    if (!jpeg) {
      photoClassifications.push({ index: i + 1, view: "unclear", valid: false, invalidReason: "No se pudo descargar la foto.", assetId: item.id });
      continue;
    }
    try {
      const extraction = await extractLandmarksFromPhoto({ jpeg, photoLabel: `Foto del Hip ${opts.hipNumber} #${i + 1}` });
      photoClassifications.push({
        index: i + 1,
        view: extraction.view,
        valid: extraction.valid,
        invalidReason: extraction.invalidReason,
        assetId: item.id,
      });
      if (extraction.valid && extraction.view !== "unclear") {
        results.push({
          index: i + 1,
          view: extraction.view,
          valid: true,
          landmarks: extraction.landmarks as ViewLandmarks,
          overallConfidence: extraction.overallConfidence,
          assetId: item.id,
        });
      }
    } catch (err) {
      console.error(`[analysis] Error extrayendo landmarks de la foto #${i + 1} del Hip ${opts.hipNumber}:`, err);
      photoClassifications.push({ index: i + 1, view: "unclear", valid: false, invalidReason: "Error al procesar la foto.", assetId: item.id });
    }
  }

  if (results.length === 0) {
    throw new NoPhotosError("No se pudo procesar ninguna foto válida de este Hip.");
  }

  // Paso 3 — por vista, la MEJOR foto disponible (mayor confianza global) — mismo criterio que la metodología legado.
  const bestByView: Partial<Record<ViewName, PhotoResult>> = {};
  for (const r of results) {
    const current = bestByView[r.view as ViewName];
    if (!current || r.overallConfidence > current.overallConfidence) {
      bestByView[r.view as ViewName] = r;
    }
  }

  // Paso 4 — mediciones + hallazgos + score, vista por vista.
  const scores = emptyScores();
  const detail = {} as Record<ViewName, ViewAnalysisDetail>;
  const viewSourceAssetIds: Partial<Record<ViewName, string>> = {};
  const summaryLines: string[] = [];

  for (const view of ["frontal", "lateral", "posterior"] as const) {
    const best = bestByView[view];
    if (!best) {
      detail[view] = { available: false, landmarks: null, findings: [], score: null, displayFindings: [] };
      for (const key of VIEW_SUBKEYS[view]) setScore(scores, `${view}.${key}`, 0);
      summaryLines.push(`${viewLabelEs(view)}: sin foto válida, no evaluado.`);
      continue;
    }

    // El patrón RM de 10.0/10 del referente (ver referenceCalibration.ts)
    // entra acá — SOLO afina la puntuación dentro de la banda ya
    // anatómicamente segura (ver severity.classifySeverity), nunca
    // reclasifica un defecto real como correcto.
    const referenceMetrics = calibration.referenceMetrics?.[view];
    const { findings } =
      view === "frontal"
        ? evaluateFrontalFindings(best.landmarks as ViewLandmarks<"frontal">, best.overallConfidence, referenceMetrics)
        : view === "lateral"
        ? evaluateLateralFindings(best.landmarks as ViewLandmarks<"lateral">, best.overallConfidence, referenceMetrics)
        : evaluatePosteriorFindings(best.landmarks as ViewLandmarks<"posterior">, best.overallConfidence, referenceMetrics);

    const viewScore = scoreView(findings);
    const displayFindings = prioritizeFindings(findings, 2);

    detail[view] = { available: true, landmarks: best.landmarks, findings, score: viewScore, displayFindings };
    if (best.assetId) viewSourceAssetIds[view] = best.assetId;
    for (const key of VIEW_SUBKEYS[view]) setScore(scores, `${view}.${key}`, viewScore.score);

    summaryLines.push(summarizeView(view, viewScore.score, displayFindings));
  }

  return {
    scores,
    photoClassifications,
    summary: summaryLines.join(" "),
    methodologyVersion: METHODOLOGY_VERSION,
    detail,
    viewSourceAssetIds,
  };
}

function viewLabelEs(view: ViewName): string {
  if (view === "frontal") return "Frontal";
  if (view === "lateral") return "Lateral";
  return "Posterior";
}

/**
 * Resumen determinístico (NO generado por un modelo — armado a partir de
 * los mismos hallazgos priorizados que ve la pantalla) — mismas 2 entradas
 * siempre producen el mismo texto, reforzando la reproducibilidad general
 * del motor.
 */
function summarizeView(view: ViewName, score: number, displayFindings: DisplayFinding[]): string {
  const label = viewLabelEs(view);
  if (displayFindings.length === 0) return `${label}: correcto (${score.toFixed(1)}).`;
  const names = displayFindings.map((f) => `${f.labelEs} (${f.severity})`).join(", ");
  return `${label}: ${names} — ${score.toFixed(1)}.`;
}

// Re-exportado por compatibilidad con quien todavía importe findDefect
// desde acá (ninguno al momento de escribir esto, pero evita romper algo
// si se agrega en el futuro un import corto).
export { findDefect };
