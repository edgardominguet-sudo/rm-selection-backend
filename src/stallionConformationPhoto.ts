import { STALLION_FARM_PAGES } from "./stallionFarmPages";

/**
 * Foto LATERAL (conformación) de cada padrillo — 2026-10-17, pedido de
 * Ramon: "necesitamos la foto lateral de cada stallion" (la imagen de vista
 * previa de la página a veces es una foto de carrera, ej. Arcangelo).
 *
 * Cada haras publica en la página de su padrillo una "conformation shot"
 * (la foto de perfil, de pie). Acá se lee la página OFICIAL y se elige esa
 * imagen por su nombre de archivo / texto alternativo (los haras la rotulan:
 * "Forte-Conformation.jpg", "Gunite conformation shot", "Arcangelo
 * Conformation"). Nunca se copia ni se guarda la foto: solo se devuelve su
 * enlace, y la app la muestra en vivo desde el haras. Sin una foto de
 * conformación clara -> null (la app muestra la página del haras, nunca una
 * foto equivocada).
 */

const CONFORMATION = /conformation|conform|confo\b|\bconf\b|[-_]cn[-_]|stallion[-_ ]?shot|standing/i;
const NOT_CONFORMATION =
  /head[-_ ]?shot|headshot|logo|silk|swatch|pedigree|race[-_ ]?record|paddock|gallery|foal|filly|colt|weanling|yearling|hip[-_ ]?\d|derby|stakes|travers|belmont|breeders|walking|stallplate|plate|nicks|goldmine|\.svg|background|feature|rectangle|social|icon|banner/i;

type Candidate = { url: string; alt: string };

const cache = new Map<string, { at: number; value: string | null }>();
const TTL_MS = 24 * 60 * 60 * 1000;

function key(name: string): string {
  return name.trim().toUpperCase().replace(/\s*\([A-Z]{2,3}\)\s*$/, "").replace(/[^A-Z0-9]/g, "");
}

export function farmPageFor(name: string): string | null {
  const k = key(name);
  const hit = STALLION_FARM_PAGES.find(([n]) => key(n) === k);
  return hit ? hit[1] : null;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m ? m[1].trim() : null;
}

function candidates(html: string, page: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = attr(tag, "srcset") ?? attr(tag, "data-srcset");
    // De un srcset se toma la versión más grande (última de la lista).
    const fromSrcset = srcset ? srcset.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop() : null;
    const raw = attr(tag, "data-src") ?? attr(tag, "src") ?? fromSrcset;
    if (!raw || raw.startsWith("data:")) continue;
    try {
      out.push({ url: new URL(raw.replace(/&amp;/g, "&"), page).toString(), alt: attr(tag, "alt") ?? attr(tag, "title") ?? "" });
    } catch {
      /* URL inválida: se ignora */
    }
  }
  // Enlaces directos a imágenes (galerías que abren la foto grande).
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.(?:jpe?g|png|webp))["'][^>]*>/gi)) {
    try {
      out.push({ url: new URL(m[1].replace(/&amp;/g, "&"), page).toString(), alt: attr(m[0], "title") ?? "" });
    } catch {
      /* ignorar */
    }
  }
  return out;
}

export function pickConformationPhoto(html: string, page: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const c of candidates(html, page)) {
    const file = decodeURIComponent(c.url.split("?")[0].split("/").pop() ?? "");
    const text = `${file} ${c.alt}`;
    if (!CONFORMATION.test(text) || NOT_CONFORMATION.test(text)) continue;
    // Preferir la versión grande (sin sufijo de miniatura "-300x200").
    const score = 100 - (/-\d{2,4}x\d{2,4}\./.test(file) ? 10 : 0);
    if (!best || score > best.score) best = { url: c.url, score };
  }
  return best?.url ?? null;
}

export async function conformationPhotoFor(name: string): Promise<{ pageUrl: string | null; photoUrl: string | null }> {
  const pageUrl = farmPageFor(name);
  if (!pageUrl) return { pageUrl: null, photoUrl: null };
  const cached = cache.get(pageUrl);
  if (cached && Date.now() - cached.at < TTL_MS) return { pageUrl, photoUrl: cached.value };
  let photoUrl: string | null = null;
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) photoUrl = pickConformationPhoto(await response.text(), pageUrl);
  } catch {
    /* sin red o página caída: null, se reintenta en el próximo pedido */
    return { pageUrl, photoUrl: null };
  }
  cache.set(pageUrl, { at: Date.now(), value: photoUrl });
  return { pageUrl, photoUrl };
}
