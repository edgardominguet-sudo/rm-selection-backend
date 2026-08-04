import { createHash } from "node:crypto";
import { CatalogMediaItem } from "../types";

/**
 * Quita query string y fragment de una URL antes de compararla — algunas
 * casas de ventas sirven las mismas fotos/video con parámetros que
 * cambian en cada respuesta (cache-busting, tokens firmados con
 * expiración), y sin esto cada chequeo de catálogo parecería traer "media
 * nueva" aunque la foto sea exactamente la misma, disparando reanálisis
 * innecesarios (con el costo de IA que eso implica). Si la URL no es
 * parseable, se usa tal cual — mejor un falso positivo ocasional que
 * perder la detección de cambios reales.
 */
function normalizeMediaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Huella estable del contenido de media relevante para el análisis
 * (fotos + video) de un Hip. Comparar esta huella contra la que se guardó
 * en el último análisis exitoso (Hip.analyzedMediaHash) es lo que permite
 * detectar "apareció una foto o video nuevo" sin tener que re-analizar
 * TODO el catálogo en cada chequeo — solo se reanalizan los Hips cuya
 * huella cambió.
 */
export function mediaFingerprint(media: CatalogMediaItem[]): string {
  const relevant = media
    .filter((m) => m.kind === "photo" || m.kind === "video")
    .map((m) => `${m.kind}:${normalizeMediaUrl(m.url)}`)
    .sort();
  return createHash("sha256").update(relevant.join("|")).digest("hex");
}
