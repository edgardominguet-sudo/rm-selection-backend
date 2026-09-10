import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
// BUG REAL ENCONTRADO Y CORREGIDO (2026-09-10, en la prueba de punta a
// punta del análisis automático de video en producción real contra
// Keeneland): faltaba esta línea. `ffmpeg-static` SOLO trae el binario
// `ffmpeg` — el binario `ffprobe` (que usa `probeDuration` de más abajo,
// vía `ffmpeg.ffprobe(...)`) es un paquete aparte (`ffprobe-static`) que
// nunca se había instalado ni configurado. Sin esto, TODA llamada a
// `ffmpeg.ffprobe(...)` fallaba (spawn ENOENT: no existe ningún binario
// llamado `ffprobe` en el PATH del contenedor de Railway) — nunca por un
// video puntual roto o todavía transcodificando, sino SIEMPRE, para
// cualquier video, desde el día uno de esta función. Confirmado en la
// prueba real: cientos de Hips de Keeneland con video YA PUBLICADO Y
// ESTABLE (no solo los recién publicados) fallaban por igual — la
// consistencia total del fallo (no un porcentaje) fue la pista de que no
// era un problema de contenido sino de binario faltante.
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
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
 * archivo — para eso ver resolveVimeoPlayableUrl más abajo).
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

export interface ResolvedVimeoVideo {
  url: string;
  isHls: boolean;
}

/**
 * Resuelve una URL reproducible de un video de Vimeo público a partir de
 * su ID, usando el endpoint de configuración del reproductor (no requiere
 * token ni permisos de OAuth — es el mismo JSON que consulta el
 * reproductor embebido público, por eso funciona para videos de catálogo
 * que no son propiedad del dueño del token). Esta es una mejora respecto
 * al enfoque de iOS (que tenía que abrir el reproductor en un WKWebView
 * oculto y sacarle capturas de pantalla porque la API oficial de Vimeo
 * devuelve 403 para videos ajenos) — server-side alcanza con este
 * endpoint público.
 *
 * BUG REAL ENCONTRADO Y CORREGIDO (2026-09-10, misma prueba de punta a
 * punta en producción, inmediatamente después de corregir el binario de
 * `ffprobe`): con ese binario ya arreglado, TODOS los videos de Keeneland
 * seguían sin producir ningún fotograma. Se confirmó en vivo, contra este
 * mismo endpoint, que Vimeo YA NO entrega archivos "progressive" (MP4
 * directo descargable) para estos videos — `request.files` únicamente
 * trae `dash` y `hls` (streaming adaptativo). El video en sí es público y
 * se reproduce sin problema (confirmado abriendo el reproductor real);
 * Vimeo simplemente dejó de exponer el MP4 directo que este código
 * esperaba. Antes esta función devolvía null apenas no había
 * "progressive" — ahora, si falta, cae a la URL del manifiesto HLS
 * maestro como respaldo: ffmpeg lee HLS de forma nativa (ninguna
 * dependencia nueva), así que no se pierde ningún video real por esto,
 * solo cambia el contenedor de origen.
 *
 * Puede devolver null si el video no es embebible públicamente en
 * absoluto (privacidad restringida por el dueño) — en ese caso, igual
 * que antes, el análisis simplemente sigue sin fotograma para ese video.
 */
export async function resolveVimeoPlayableUrl(vimeoVideoId: string): Promise<ResolvedVimeoVideo | null> {
  try {
    const response = await fetch(`https://player.vimeo.com/video/${vimeoVideoId}/config`, {
      headers: { Referer: "https://player.vimeo.com/" },
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      request?: {
        files?: {
          progressive?: { url: string; height: number }[];
          hls?: { default_cdn?: string; cdns?: Record<string, { avc_url?: string; url?: string }> };
        };
      };
    };
    const progressive = json.request?.files?.progressive ?? [];
    if (progressive.length > 0) {
      // La de mayor calidad disponible, pero sin pasarnos: 720p alcanza de
      // sobra para lo que se necesita (fotogramas se reescalan a 1024px
      // igual antes de mandarse a la IA).
      const sorted = [...progressive].sort((a, b) => b.height - a.height);
      const url = sorted.find((f) => f.height <= 720)?.url ?? sorted[sorted.length - 1].url;
      return { url, isHls: false };
    }
    const hls = json.request?.files?.hls;
    const cdnKey = hls?.default_cdn;
    const cdn = cdnKey ? hls?.cdns?.[cdnKey] : undefined;
    // `avc_url` fuerza H.264 (compatibilidad máxima con ffmpeg); `url` es
    // el respaldo genérico si esa variante puntual no viniera.
    const hlsUrl = cdn?.avc_url ?? cdn?.url;
    if (hlsUrl) return { url: hlsUrl, isHls: true };
    return null;
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
    const resolved = await resolveVimeoPlayableUrl(id);
    if (!resolved) return EMPTY_RESULT;
    return extractFramesFromUrl(resolved.url);
  }
  // URL directa (mp4 propio del catálogo, ej. under_tack_show_video).
  return extractFramesFromUrl(videoUrl);
}

/**
 * Extrae UN SOLO fotograma JPEG, en el punto medio del clip — pensado para
 * ANÁLISIS AUTOMÁTICO Y SILENCIOSO DE VIDEO (2026-09-10, a pedido explícito
 * de Ramon: "enviar automáticamente ese mismo video al motor de análisis de
 * IA", resultado "exactamente en el formato establecido actualmente"). A
 * diferencia de `extractFramesFromUrl` (hasta 40 fotogramas, pensado para
 * un análisis de marcha por movimiento que hoy no está conectado a ningún
 * lado — ver comentario de `extractGaitFrames`), acá alcanza con UN
 * fotograma representativo porque el destino es el MISMO motor de fotos
 * fijas que ya usa Análisis IA (tarjeta LATERAL) — no se reinventa ningún
 * criterio de puntaje nuevo, se le da al motor existente una foto más,
 * simplemente obtenida de un video en vez de la cámara. El punto medio
 * (50% de la duración) es una elección determinística y estable: mismo
 * video → mismo instante → mismo fotograma siempre, sin importar cuántas
 * veces se vuelva a correr (necesario para el caché por hash exacto de
 * `landmarkVisionClient.ts` y para que el resultado no dependa de qué
 * dispositivo o qué momento disparó el análisis).
 */
async function extractSingleFrame(videoUrl: string, atFraction = 0.5): Promise<Buffer | null> {
  const durationSeconds = await probeDuration(videoUrl);
  if (!durationSeconds) return null;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rm-frame-"));
  try {
    const clamped = Math.min(Math.max(atFraction, 0), 0.999);
    const timestamp = durationSeconds * clamped;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoUrl)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .screenshots({
          timestamps: [timestamp],
          filename: "frame.jpg",
          folder: tmpDir,
          size: "?x720",
        });
    });

    return await readFile(path.join(tmpDir, "frame.jpg"));
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Punto de entrada único para el análisis automático de video (ver
 * `extractSingleFrame` arriba) — mismo camino de resolución de URL
 * (Vimeo progresivo o mp4 directo) que `extractGaitFrames`, pero
 * devolviendo un solo fotograma en vez de una serie. Nunca tira
 * excepción: `null` si el video no se pudo leer por ningún camino (privado,
 * solo HLS segmentado, URL rota, etc.) — quien llama simplemente no genera
 * ningún fotograma automático para ese video, sin romper nada más.
 */
export async function extractRepresentativeVideoFrame(videoUrl: string): Promise<Buffer | null> {
  if (videoUrl.includes("vimeo.com")) {
    const id = vimeoIdFromUrl(videoUrl);
    if (!id) return null;
    const resolved = await resolveVimeoPlayableUrl(id);
    if (!resolved) return null;
    return extractSingleFrame(resolved.url);
  }
  // URL directa (mp4 propio del catálogo, o un manifiesto HLS/.m3u8 que
  // la propia casa de ventas sirva de forma directa): ffmpeg lee ambos
  // formatos de forma nativa, así que ya no se descarta a propósito como
  // antes (esa restricción impedía justamente el respaldo HLS agregado
  // arriba en resolveVimeoPlayableUrl).
  return extractSingleFrame(videoUrl);
}
