// Cliente de visión para EXTRACCIÓN DE LANDMARKS (una foto por llamada) —
// hermano de anthropicClient.ts pero con una tarea mucho más acotada (ver
// landmarkExtractionPrompt.ts). Reusa el mismo patrón de reintento con
// backoff que ya existía para la metodología legado.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { buildLandmarkExtractionPrompt, extractLandmarkResponse, ParsedLandmarkExtraction } from "./landmarkExtractionPrompt";
import { ViewName } from "./landmarks";
import { correctLeftRightConsistency } from "./landmarkSideConsistency";

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
  if (response.stop_reason === "max_tokens") {
    // Causa raíz real (diagnosticada 2026-08-14): con max_tokens=2048 el
    // modelo alcanza a describir solo ~4 de los ~18-20 landmarks de una
    // vista antes de cortar la respuesta a mitad de un valor — el JSON
    // queda truncado y el parser lo descarta (con razón: no es JSON
    // válido). Subido a 8192 más abajo; este chequeo deja el motivo
    // explícito en vez de un genérico "formato inesperado" si algún día
    // vuelve a pasar (foto más compleja, prompt más largo, etc.).
    throw new LandmarkExtractionError(
      `La respuesta de landmarks para ${opts.photoLabel} se cortó por límite de tokens (max_tokens) antes de completar el JSON.`
    );
  }
  const parsed = extractLandmarkResponse(firstText.text);
  if (!parsed) {
    const snippet = firstText.text.slice(0, 400).replace(/\s+/g, " ");
    throw new LandmarkExtractionError(
      `Respuesta de landmarks con formato inesperado para ${opts.photoLabel}. Fragmento crudo: ${snippet}`
    );
  }

  // Corrección de consistencia izquierda/derecha (2026-08-14, autorizada
  // por Ramon) — ver landmarkSideConsistency.ts para la justificación
  // completa. Se aplica ACÁ, en el único lugar por donde pasa toda
  // extracción de landmarks (Hips reales Y calibración del referente),
  // para que ningún cálculo aguas abajo (rmPriorityRules.ts) reciba
  // nunca un lado invertido. No cambia ningún criterio ni tolerancia —
  // solo corrige la IDENTIFICACIÓN de qué pata es cuál antes de medir.
  if (parsed.valid) {
    const correction = correctLeftRightConsistency(parsed.view, parsed.landmarks);
    if (correction.swapped) {
      console.warn(
        `[analysis] Consistencia izquierda/derecha: se corrigió una inversión de lado en "${opts.photoLabel}" (vista ${parsed.view}) — ${correction.votesInverted} de ${correction.votesInverted + correction.votesNormal} pares de landmarks salieron con el lado invertido respecto al esperado. Se intercambiaron todos los pares Left/Right de esta foto antes de calcular hallazgos.`
      );
      parsed.landmarks = correction.landmarks;
    }
  }

  return parsed;
}

// Timeout explícito por llamada (2026-08-14, mismo día que se detectó
// durante la prueba de reproducibilidad de Ramon): antes de esto, una
// llamada a Anthropic sin respuesta se quedaba colgada indefinidamente —
// sin lanzar excepción, sin timeout del SDK, bloqueando esa foto (y por
// lo tanto ese Hip) para siempre. 4 minutos es holgado para una sola
// imagen con max_tokens=8192, pero acota el peor caso — al vencer, cae
// en el mismo catch que cualquier otro error de esta función y el
// llamador (anthropicClient.ts) ya sabe tratar una foto fallida como
// "no se pudo procesar" sin tumbar el análisis completo.
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

async function sendWithRetry(client: Anthropic, content: Array<ImageBlock | TextBlock>, attempt = 1): Promise<Anthropic.Message> {
  try {
    return await client.messages.create(
      {
        model: config.anthropicModel,
        // Subido de 2048 a 8192 (2026-08-14): con 2048 el modelo cortaba a
        // mitad de la lista de landmarks en vistas con ~20 puntos (lateral
        // es la más larga — ver LATERAL_LANDMARK_IDS en landmarks.ts) y el
        // JSON quedaba truncado/inválido. 8192 deja margen holgado incluso
        // si el modelo agrega algo de formato extra.
        max_tokens: 8192,
        // Mismo criterio que anthropicClient.ts: NO se agrega `temperature`
        // (claude-sonnet-5 devuelve 400 con ese campo presente). La
        // reproducibilidad de ESTE motor no depende de eso — depende de que
        // la geometría (geometry.ts, rmPriorityRules.ts, scoringEngine.ts)
        // sea 100% determinística una vez que hay coordenadas, y de que la
        // tarea de extracción sea lo más acotada/objetiva posible (ubicar un
        // punto es mucho más estable entre llamadas que "elegir un puntaje
        // 0-10"). Ver reporte de reproducibilidad de esta tarea.
        messages: [{ role: "user", content: content as unknown as Anthropic.MessageParam["content"] }],
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status && [502, 503, 504, 429].includes(status) && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      return sendWithRetry(client, content, attempt + 1);
    }
    throw err;
  }
}
