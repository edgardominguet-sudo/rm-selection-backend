import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { buildPrompt, extractScores } from "./prompt";
import { downscaleToJPEG, fetchAndDownscale } from "./imageDownscale";
import { extractGaitFrames } from "./frameExtraction";
import { ALL_TRAIT_IDS, ConformationScores, emptyScores, setScore, GAIT_TRAITS } from "./conformationScores";
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

export interface ReferenceHorseAssets {
  photoUrls: string[];
  gaitVideoUrl?: string | null;
}

export interface AnalysisOutcome {
  scores: ConformationScores;
  gaitFrameCount: number;
  gaitVideoDurationSec: number | null;
}

/**
 * Corre el análisis de conformación de un Hip contra el caballo referente
 * — puerto directo de AnthropicVisionScoringService.analyze(hip:) de la
 * app iOS, con la misma regla central de comparación y el mismo criterio
 * de "sin video no se inventa Marcha" (gait.* en 0 si no hay fotogramas).
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
  if (opts.reference.photoUrls.length === 0) {
    throw new MissingReferenceHorseError("Falta configurar las fotos del caballo referente.");
  }

  const photoItems = opts.media.filter((m) => m.kind === "photo").slice(0, 4);
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

  const videoItem = opts.media.find((m) => m.kind === "video");
  const hipGaitResult = videoItem ? await extractGaitFrames(videoItem.url) : { frames: [], durationSeconds: null };
  const hipGaitBlocks = (
    await Promise.all(hipGaitResult.frames.map((f) => downscaleToJPEG(f)))
  ).filter((b): b is Buffer => b !== null).map(imageBlock);

  const referencePhotoBlocks: ImageBlock[] = [];
  for (const url of opts.reference.photoUrls.slice(0, 6)) {
    const jpeg = await fetchAndDownscale(url);
    if (jpeg) referencePhotoBlocks.push(imageBlock(jpeg));
  }

  let referenceGaitBlocks: ImageBlock[] = [];
  if (opts.reference.gaitVideoUrl) {
    const refGaitResult = await extractGaitFrames(opts.reference.gaitVideoUrl);
    referenceGaitBlocks = (
      await Promise.all(refGaitResult.frames.map((f) => downscaleToJPEG(f)))
    ).filter((b): b is Buffer => b !== null).map(imageBlock);
  }

  const promptText = buildPrompt({
    hipNumber: opts.hipNumber,
    horseName: opts.horseName,
    includesHipVideoFrames: hipGaitBlocks.length > 0,
    includesReferenceGaitFrames: referenceGaitBlocks.length > 0,
  });

  // Mismo orden que la versión iOS: instrucciones -> caballo referente
  // completo -> Hip a evaluar, para que la IA "mire" primero el patrón.
  const content: ContentBlock[] = [textBlock(promptText)];
  content.push(textBlock("=== FOTOS DEL CABALLO REFERENTE (patrón oficial del Método RM — la base de toda la comparación) ==="));
  content.push(...referencePhotoBlocks);
  if (referenceGaitBlocks.length > 0) {
    content.push(textBlock("=== FOTOGRAMAS DE MARCHA DEL CABALLO REFERENTE (video de referencia, recorrido completo de punta a punta) ==="));
    content.push(...referenceGaitBlocks);
  }
  const horseLabel = opts.horseName ? ` (${opts.horseName})` : "";
  content.push(textBlock(`=== FOTOS DEL HIP A EVALUAR: Hip ${opts.hipNumber}${horseLabel} ===`));
  content.push(...hipImageBlocks);
  if (hipGaitBlocks.length > 0) {
    content.push(textBlock("=== FOTOGRAMAS DE MARCHA DEL HIP A EVALUAR (video de este ejemplar, recorrido completo de punta a punta) ==="));
    content.push(...hipGaitBlocks);
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await sendWithRetry(client, content);

  const firstText = response.content.find((b) => b.type === "text");
  if (!firstText || firstText.type !== "text") {
    throw new AIResponseError("La IA no devolvió un resultado que se pudiera interpretar.");
  }

  const scoresDict = extractScores(firstText.text);
  if (!scoresDict) {
    throw new AIResponseError("La IA no devolvió un resultado que se pudiera interpretar.");
  }

  const scores = emptyScores();
  for (const traitId of ALL_TRAIT_IDS) {
    if (scoresDict[traitId] !== undefined) {
      setScore(scores, traitId, scoresDict[traitId]);
    }
  }

  // Sin fotogramas de marcha reales, no se "adivina" la Marcha — mismo
  // criterio que la versión iOS: esas 7 subcategorías quedan en 0.
  if (hipGaitBlocks.length === 0) {
    for (const trait of GAIT_TRAITS) scores.gait[trait] = 0;
  }

  return {
    scores,
    gaitFrameCount: hipGaitBlocks.length,
    gaitVideoDurationSec: hipGaitResult.durationSeconds,
  };
}

async function sendWithRetry(client: Anthropic, content: ContentBlock[], attempt = 1): Promise<Anthropic.Message> {
  try {
    return await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 1536,
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
