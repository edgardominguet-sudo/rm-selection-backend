// Cliente de visión para EXTRACCIÓN DE LANDMARKS (una foto por llamada) —
// hermano de anthropicClient.ts pero con una tarea mucho más acotada (ver
// landmarkExtractionPrompt.ts). Reusa el mismo patrón de reintento con
// backoff que ya existía para la metodología legado.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { buildLandmarkExtractionPrompt, extractLandmarkResponse, ParsedLandmarkExtraction } from "./landmarkExtractionPrompt";
import { ViewName } from "./landmarks";

export class LandmarkExtractionError extends Error {}

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
type TextBlock = { type: "text"; text: string };

function imageBlock(jpeg: Buffer): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } };
}

export async function extractLandmarksFromPhoto(opts: {
  jpeg: Buffer;
  photoLabel: string;
  expectedView?: ViewName;
}): Promise<ParsedLandmarkExtraction> {
  if (!config.anthropicApiKey) {
    throw new Error("Falta ANTHROPIC_API_KEY en la configuración del backend.");
  }
  const promptText = buildLandmarkExtractionPrompt({ expectedView: opts.expectedView, photoLabel: opts.photoLabel });
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const content: Array<ImageBlock | TextBlock> = [
    { type: "text", text: promptText },
    imageBlock(opts.jpeg),
  ];

  const response = await sendWithRetry(client, content);
  const firstText = response.content.find((b) => b.type === "text");
  if (!firstText || firstText.type !== "text") {
    throw new LandmarkExtractionError(`No se pudo interpretar la respuesta de extracción de landmarks para ${opts.photoLabel}.`);
  }
  const parsed = extractLandmarkResponse(firstText.text);
  if (!parsed) {
    // DIAGNÓSTICO TEMPORAL (2026-08-14): se incluye un fragmento de la
    // respuesta cruda en el mensaje de error para poder ver EXACTAMENTE
    // por qué falló el parseo (JSON truncado, texto extra, etc.) sin tener
    // que loguear la respuesta completa en cada corrida normal. Quitar
    // este fragmento una vez diagnosticado y corregido el parser.
    const snippet = firstText.text.slice(0, 400).replace(/\s+/g, " ");
    throw new LandmarkExtractionError(
      `Respuesta de landmarks con formato inesperado para ${opts.photoLabel}. Fragmento crudo: ${snippet}`
    );
  }
  return parsed;
}

async function sendWithRetry(client: Anthropic, content: Array<ImageBlock | TextBlock>, attempt = 1): Promise<Anthropic.Message> {
  try {
    return await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 2048,
      // Mismo criterio que anthropicClient.ts: NO se agrega `temperature`
      // (claude-sonnet-5 devuelve 400 con ese campo presente). La
      // reproducibilidad de ESTE motor no depende de eso — depende de que
      // la geometría (geometry.ts, rmPriorityRules.ts, scoringEngine.ts)
      // sea 100% determinística una vez que hay coordenadas, y de que la
      // tarea de extracción sea lo más acotada/objetiva posible (ubicar un
      // punto es mucho más estable entre llamadas que "elegir un puntaje
      // 0-10"). Ver reporte de reproducibilidad de esta tarea.
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
