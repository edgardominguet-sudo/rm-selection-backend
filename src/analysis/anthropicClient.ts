import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { buildPrompt, extractAnalysisResponse, PhotoClassification } from "./prompt";
import { fetchAndDownscale } from "./imageDownscale";
import { ALL_TRAIT_IDS, ConformationScores, emptyScores, setScore, METHODOLOGY_VERSION } from "./conformationScores";
import { CatalogMediaItem } from "../types";

export class MissingReferenceHorseError extends Error {}
export class NoPhotosError extends Error {}
export class AIResponseError extends Error {}

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
type TextBlock = { type: "text"; text: string };
type ContentBlock = ImageBlock | TextBlock;

function imageBlock(jpeg: Buffer): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } };
}
function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

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

export interface AnalysisOutcome {
  scores: ConformationScores;
  photoClassifications: PhotoClassification[];
  summary: string | null;
  methodologyVersion: string;
}

/**
 * Corre el análisis de conformación de un Hip contra el caballo referente
 * — metodología nueva (2026-08-13): anatomía comparativa por vista
 * (LATERAL/FRONTAL/POSTERIOR), sin Marcha. Puerto directo de
 * AnthropicVisionScoringService.analyze(hip:) de la app iOS.
 */
export async function analyzeHip(opts: {
  hipNumber: string;
  horseName?: string;
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

  const hipImageBlocks: ImageBlock[] = [];
  for (const item of photoItems) {
    const jpeg = await fetchAndDownscale(item.url);
    if (jpeg) hipImageBlocks.push(imageBlock(jpeg));
  }
  if (hipImageBlocks.length === 0) {
    throw new NoPhotosError("No se pudo descargar ninguna foto de este Hip.");
  }

  const [lateralJpeg, frontalJpeg, posteriorJpeg] = await Promise.all([
    fetchAndDownscale(opts.reference.lateralPhotoUrl),
    fetchAndDownscale(opts.reference.frontalPhotoUrl),
    fetchAndDownscale(opts.reference.posteriorPhotoUrl),
  ]);
  if (!lateralJpeg || !frontalJpeg || !posteriorJpeg) {
    throw new MissingReferenceHorseError(
      "No se pudo descargar alguna de las 3 fotos del caballo referente."
    );
  }

  const promptText = buildPrompt({
    hipNumber: opts.hipNumber,
    horseName: opts.horseName,
    photoCount: hipImageBlocks.length,
  });

  // Orden: instrucciones -> caballo referente (las 3 vistas, cada una
  // etiquetada explícitamente para que la IA no tenga que adivinar cuál es
  // cuál) -> fotos del Hip a evaluar, numeradas en el mismo orden que se le
  // pide que devuelva en "photos".
  const content: ContentBlock[] = [textBlock(promptText)];
  content.push(textBlock("=== CABALLO REFERENTE — VISTA LATERAL (patrón anatómico oficial) ==="));
  content.push(imageBlock(lateralJpeg));
  content.push(textBlock("=== CABALLO REFERENTE — VISTA FRONTAL (patrón anatómico oficial) ==="));
  content.push(imageBlock(frontalJpeg));
  content.push(textBlock("=== CABALLO REFERENTE — VISTA POSTERIOR (patrón anatómico oficial) ==="));
  content.push(imageBlock(posteriorJpeg));

  const horseLabel = opts.horseName ? ` (${opts.horseName})` : "";
  content.push(textBlock(`=== FOTOS DEL HIP A EVALUAR: Hip ${opts.hipNumber}${horseLabel} — clasificalas y validalas primero (Paso 1) ===`));
  hipImageBlocks.forEach((block, i) => {
    content.push(textBlock(`--- Foto del Hip #${i + 1} ---`));
    content.push(block);
  });

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await sendWithRetry(client, content);

  const firstText = response.content.find((b) => b.type === "text");
  if (!firstText || firstText.type !== "text") {
    throw new AIResponseError("La IA no devolvió un resultado que se pudiera interpretar.");
  }

  const parsed = extractAnalysisResponse(firstText.text);
  if (!parsed) {
    throw new AIResponseError("La IA no devolvió un resultado que se pudiera interpretar.");
  }

  const scores = emptyScores();
  for (const traitId of ALL_TRAIT_IDS) {
    if (parsed.scores[traitId] !== undefined) {
      setScore(scores, traitId, parsed.scores[traitId]);
    }
  }

  // Defensa adicional (además de la instrucción del prompt): una vista sin
  // ninguna foto válida clasificada no puede quedar con puntaje "inventado"
  // por el modelo — se fuerza a 0 acá también, mismo criterio que ya usaba
  // el motor legado para forzar Marcha a 0 sin video (ver comentario en
  // conformationScores.ts, overallScore).
  const validViews = new Set(parsed.photos.filter((p) => p.valid).map((p) => p.view));
  if (!validViews.has("lateral")) for (const t of ["proportions", "topline", "structure"]) scores.lateral[t] = 0;
  if (!validViews.has("frontal")) for (const t of ["alignment", "symmetry", "proportions"]) scores.frontal[t] = 0;
  if (!validViews.has("posterior")) for (const t of ["alignment", "structure", "symmetry"]) scores.posterior[t] = 0;

  return {
    scores,
    photoClassifications: parsed.photos,
    summary: parsed.summary,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

async function sendWithRetry(client: Anthropic, content: ContentBlock[], attempt = 1): Promise<Anthropic.Message> {
  try {
    return await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 2048,
      // NOTA (2026-08-11, heredada de la metodología legado): NO se agrega
      // temperature acá — claude-sonnet-5 devuelve 400 ("temperature is
      // deprecated for this model") apenas el campo está presente, sea cual
      // sea el valor. La reproducibilidad se apoya en lo que sí es 100%
      // determinista: el armado del prompt (prompt.ts) y las 3 fotos fijas
      // del referente (siempre las mismas URLs mientras no se reemplace el
      // referente).
      messages: [{ role: "user", content: content as unknown as Anthropic.MessageParam["content"] }],
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status && [502, 503, 504, 429].includes(status) && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      return sendWithRetry(client, content, attempt + 1);
    }
    throw err;
  }
}
