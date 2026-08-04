import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

export interface FrameExtractionResult {
  frames: Buffer[];
  durationSeconds: number | null;
}

export const EMPTY_RESULT: FrameExtractionResult = { frames: [], durationSeconds: null };

// Puerto de RMSelection/Utilities/VideoFrameExtractor.swift (GaitFrameSampling):
// densidad objetivo 1 fotograma/segundo, piso 12, techo 40 — un clip largo
// se cubre con muchos más fotogramas que uno corto, sin pasarse del
// presupuesto de imágenes por consulta a la API.
export const GAIT_FRAME_TARGET_SPACING_SECONDS = 1.0;
export const GAIT_MIN_FRAMES = 12;
export const GAIT_MAX_FRAMES = 40;

export function frameCountForDuration(durationSeconds: number): number {
  if (!isFinite(durationSeconds) || durationSeconds <= 0) return GAIT_MIN_FRAMES;
  const ideal = Math.ceil(durationSeconds / GAIT_FRAME_TARGET_SPACING_SECONDS);
  return Math.min(Math.max(ideal, GAIT_MIN_FRAMES), GAIT_MAX_FRAMES);
}

function probeDuration(videoUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoUrl, (err, data) => {
      if (err) {
        resolve(null);
        return;
      }
      const duration = data.format?.duration;
      resolve(typeof duration === "number" && isFinite(duration) && duration > 0 ? duration : null);
    });
  });
}

/**
 * Extrae fotogramas JPEG de un video accesible por URL directa (mp4/mov),
 * espaciados de punta a punta según la duración real — mismo criterio que
 * VideoFrameExtractor.swift. Devuelve frames vacíos si la URL no es un
 * video que ffmpeg pueda leer (ej. una página HTML de Vimeo en vez de un
 * archivo — para eso ver resolveVimeoProgressiveUrl más abajo).
 */
export async function extractFramesFromUrl(videoUrl: string): Promise<FrameExtractionResult> {
  const durationSeconds = await probeDuration(videoUrl);
  if (!durationSeconds) return EMPTY_RESULT;

  const count = frameCountForDuration(durationSeconds);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rm-gait-"));
  try {
    const timestamps: number[] = [];
    for (let i = 0; i < count; i++) {
      const fraction = count === 1 ? 0.5 : i / (count - 1);
      const clamped = Math.min(Math.max(fraction, 0), 0.999);
      timestamps.push(durationSeconds * clamped);
    }

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoUrl)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .screenshots({
          timestamps,
          filename: "frame-%i.jpg",
          folder: tmpDir,
          size: "?x720",
        });
    });

    const frames: Buffer[] = [];
    for (let i = 1; i <= count; i++) {
      try {
        frames.push(await readFile(path.join(tmpDir, `frame-${i}.jpg`)));
      } catch {
        // Un fotograma puntual puede fallar (timestamp fuera de rango por
        // redondeo) sin que se pierda el resto.
      }
    }
    return { frames, durationSeconds };
  } catch {
    return EMPTY_RESULT;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resuelve la URL progresiva (mp4 directo) de un video de Vimeo público a
 * partir de su ID, usando el endpoint de configuración del reproductor
 * (no requiere token ni permisos de OAuth — es el mismo JSON que consulta
 * el reproductor embebido público, por eso funciona para videos de
 * catálogo que no son propiedad del dueño del token). Esta es una mejora
 * respecto al enfoque de iOS (que tenía que abrir el reproductor en un
 * WKWebView oculto y sacarle capturas de pantalla porque la API oficial
 * de Vimeo devuelve 403 para videos ajenos) — server-side alcanza con
 * este endpoint público.
 *
 * Puede devolver null si el video no es embebible públicamente (privacidad
 * restringida por el dueño) — en ese caso, igual que en iOS, el análisis
 * simplemente sigue sin fotogramas de marcha (gait.* queda en 0).
 */
export async function resolveVimeoProgressiveUrl(vimeoVideoId: string): Promise<string | null> {
  try {
    const response = await fetch(`https://player.vimeo.com/video/${vimeoVideoId}/config`, {
      headers: { Referer: "https://player.vimeo.com/" },
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      request?: { files?: { progressive?: { url: string; height: number }[] } };
    };
    const progressive = json.request?.files?.progressive ?? [];
    if (progressive.length === 0) return null;
    // La de mayor calidad disponible, pero sin pasarnos: 720p alcanza de
    // sobra para lo que se necesita (fotogramas se reescalan a 1024px
    // igual antes de mandarse a la IA).
    const sorted = [...progressive].sort((a, b) => b.height - a.height);
    return sorted.find((f) => f.height <= 720)?.url ?? sorted[sorted.length - 1].url;
  } catch {
    return null;
  }
}

export function vimeoIdFromUrl(url: string): string | null {
  const match = url.match(/\d{6,}/);
  return match ? match[0] : null;
}

/**
 * Punto de entrada único: dado un MediaItem de video (URL tal como viene
 * del catálogo), intenta extraer fotogramas de marcha por el mejor camino
 * disponible. Nunca tira excepción — si todo falla, devuelve vacío y el
 * análisis sigue solo con fotos fijas (mismo criterio de degradación
 * segura que la versión iOS).
 */
export async function extractGaitFrames(videoUrl: string): Promise<FrameExtractionResult> {
  if (videoUrl.includes("vimeo.com")) {
    const id = vimeoIdFromUrl(videoUrl);
    if (!id) return EMPTY_RESULT;
    const progressiveUrl = await resolveVimeoProgressiveUrl(id);
    if (!progressiveUrl) return EMPTY_RESULT;
    return extractFramesFromUrl(progressiveUrl);
  }
  // URL directa (mp4 propio del catálogo, ej. under_tack_show_video).
  return extractFramesFromUrl(videoUrl);
}
