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

// "confo"/"conf" seguidos de algo que no sea letra ("Blame-confo_dell",
// "Confo_Curlin", "CONF_Essential_Quality"); "cutout" = foto de perfil
// recortada (Calumet, Spendthrift).
const CONFORMATION = /conformation|conform|confo(?![a-z])|(?<![a-z])conf(?![a-z])|[-_]cn[-_]|stallion[-_ ]?shot|standing|cutout/i;
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

/** Además de <img>: cualquier enlace a imagen escrito en la página (sitios
 * que arman la galería con JavaScript, ej. Coolmore). */
function rawImageUrls(html: string): Candidate[] {
  const decoded = html
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":");
  const out: Candidate[] = [];
  for (const m of decoded.matchAll(/https?:\/\/[^"'\s<>()\\]+?\.(?:jpe?g|png|webp)/gi)) out.push({ url: m[0], alt: "" });
  return out;
}

const compact = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Elige la foto de conformación DE ESTE padrillo. Muchas páginas muestran
 * además las de otros padrillos del haras (menú, "ver también"): se exige
 * el nombre del padrillo en el archivo o el texto alternativo; solo si
 * ninguna lo tiene y hay UNA sola foto de conformación en la página, se
 * acepta esa (ej. "FA-2yo-confo.jpg" para Further Ado).
 */
export function pickConformationPhoto(html: string, page: string, stallionName = ""): string | null {
  const name = compact(stallionName.replace(/\s*\([A-Z]{2,3}\)\s*$/, ""));
  const seen = new Map<string, { url: string; named: boolean; score: number }>();
  for (const c of [...candidates(html, page), ...rawImageUrls(html)]) {
    let file = c.url.split("?")[0].split("/").pop() ?? "";
    try { file = decodeURIComponent(file); } catch { /* nombre tal cual */ }
    const text = `${file} ${c.alt}`;
    if (!CONFORMATION.test(text) || NOT_CONFORMATION.test(text)) continue;
    const named = name.length > 0 && compact(text).includes(name);
    // Preferir la versión grande (sin sufijo de miniatura "-300x200").
    const score = (named ? 100 : 0) + (/-\d{2,4}x\d{2,4}\./.test(file) ? 0 : 10);
    // Misma foto en otro tamaño cuenta una sola vez.
    const base = file.replace(/-\d{2,4}x\d{2,4}(?=\.)/, "").replace(/-scaled(?=\.)/, "").toLowerCase();
    const prev = seen.get(base);
    if (!prev || score > prev.score) seen.set(base, { url: c.url, named, score });
  }
  const all = [...seen.values()];
  const named = all.filter((c) => c.named).sort((a, b) => b.score - a.score);
  if (named.length) return named[0].url;
  // Sin el nombre: solo si es la ÚNICA foto de conformación y no lleva el
  // nombre de OTRO padrillo conocido (ej. la página de Two Phil's mostraba
  // la de Timberlake en el menú del haras).
  const others = STALLION_FARM_PAGES.map(([n]) => compact(n)).filter((n) => n.length >= 4 && n !== name);
  const unnamed = all.filter((c) => {
    const text = compact(decodeURIComponentSafe(c.url.split("?")[0].split("/").pop() ?? ""));
    return !others.some((o) => text.includes(o));
  });
  return all.length === 1 && unnamed.length === 1 ? unnamed[0].url : null;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Diagnóstico: qué recibe el servidor de la página del haras. */
export async function conformationPhotoDebug(name: string) {
  const pageUrl = farmPageFor(name);
  if (!pageUrl) return { pageUrl: null };
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await response.text();
    const imgs = [...candidates(html, pageUrl), ...rawImageUrls(html)].map((c) => c.url).filter((u) => /\.(jpe?g|png|webp)/i.test(u));
    return { pageUrl, status: response.status, length: html.length, images: imgs.slice(0, 40) };
  } catch (err) {
    return { pageUrl, error: String(err) };
  }
}

/**
 * Foto de conformación verificada a mano: haras cuya página bloquea al
 * servidor (Coolmore responde 403 a pedidos que no vienen de un navegador)
 * y haras que no rotulan la foto de perfil como "conformation".
 * Tomadas de la página oficial de cada padrillo (oct-2026). Solo enlaces.
 */
const VERIFIED_CONFORMATION_PHOTOS: ReadonlyArray<readonly [string, string]> = [
  ["American Pharoah", "https://media.coolmore.com/uploads/2025/10/American-Pharoah-conformation-shot-1.jpg"],
  ["Citizen Bull", "https://media.coolmore.com/uploads/2025/11/Citizen-Bull-conformation-shot.jpg"],
  ["Corniche", "https://media.coolmore.com/uploads/2025/10/Corniche-conformation-shot-1.jpg"],
  ["Domestic Product", "https://media.coolmore.com/uploads/2025/10/Domestic-Product-conformation-shot.jpg"],
  ["Epicenter", "https://media.coolmore.com/uploads/2025/10/Epicenter-conformation-shot-1.jpg"],
  ["Fierceness", "https://media.coolmore.com/uploads/2025/11/Fierceness-conformation-shot.jpg"],
  ["Golden Pal", "https://media.coolmore.com/uploads/2025/10/Golden-Pal-conformation-shot-1.jpg"],
  ["Gunite", "https://media.coolmore.com/uploads/2025/10/Gunite-conformation-shot-1.jpg"],
  ["Jack Christopher", "https://media.coolmore.com/uploads/2025/10/Jack-Christopher-conformation-shot-1.jpg"],
  ["Justify", "https://media.coolmore.com/uploads/2025/10/Justify-conformation-shot.jpg"],
  ["Munnings", "https://media.coolmore.com/uploads/2025/10/Munnings-conformation-shot.jpg"],
  ["Practical Joke", "https://media.coolmore.com/uploads/2025/10/Practical-Joke-conformation-shot.jpg"],
  ["Sierra Leone", "https://media.coolmore.com/uploads/2025/10/Sierra-Leone-Conformation-2026.jpg"],
  // Revisadas a ojo (2026-10-17): foto de perfil de pie del propio padrillo,
  // en haras que no la rotulan como "conformation".
  ["Two Phil's", "https://www.winstarfarm.com/wp-content/uploads/2023/08/TwoPhils__pm_0898-Resized-1.png"],
  ["Street Sense", "https://cdn.darleystallions.com/sites/default/files/drupal-media/stallion-images/USA/street-sense/st-sense-739-5021.jpg"],
  ["Beau Liam", "https://www.airdriestud.com/wp-content/uploads/2024/02/Beau-Liam2_resized9-30-2022-8-49-46-862-1.jpg"],
  ["Girvin", "https://www.airdriestud.com/wp-content/uploads/2024/02/Girvin_resized9-12-2022-10-50-58-155.jpg"],
  ["Happy Saver", "https://www.airdriestud.com/wp-content/uploads/2024/02/24_0520_Happy-Saver_mw-1888-scaled.jpg"],
  ["Highly Motivated", "https://www.airdriestud.com/wp-content/uploads/2024/02/24_0520_Highly-Motivated_mw-1966-scaled.jpg"],
  ["Annapolis", "https://claibornefarm.com/wp-content/uploads/2024/01/Annapolis.2-e1778770809170.jpg"],
  ["Johannes", "https://claibornefarm.com/wp-content/uploads/2025/11/Johannes.jpg"],
  ["Bright Future", "https://claibornefarm.com/wp-content/uploads/2024/10/20250514-2205.jpg"],
  ["Mindframe", "https://claibornefarm.com/wp-content/uploads/2025/11/Mindframe.jpg"],
  ["Prince of Monaco", "https://claibornefarm.com/wp-content/uploads/2024/10/2026-10-08-Prince-of-Monaco-6795.jpg"],
  ["Casa Creed", "https://images.squarespace-cdn.com/content/v1/60ae5a9fe8089d20ef160c5b/a7c66bc2-577d-4c5a-9934-d0776d7090fa/CasaCreed10-16-24Z10307.JPG"],
  ["Oscar Performance", "https://images.squarespace-cdn.com/content/v1/60ae5a9fe8089d20ef160c5b/a41f73a1-7d3a-4837-8c21-53ebd539aafb/OscarPerformanceZ647.JPG"],
  ["Aloha West", "https://images.squarespace-cdn.com/content/v1/60ae5a9fe8089d20ef160c5b/05b29ddd-cdbf-43ba-9e4b-dc164e286e20/thumbnail_AW+final2.jpg"],
  ["Charge It", "https://gainesway.com/wp-content/uploads/2024/09/ChargeIt_S35_5431_4x3-scaled.jpg"],
  ["Muth", "https://gainesway.com/wp-content/uploads/2024/11/Muth_S54_5128_4x3-1-scaled.jpg"],
  ["Elite Power", "https://cms.juddmonte.com/content/uploads/sites/3/2026/09/35977_crop.jpg"],
  ["Mandaloun", "https://cms.juddmonte.com/content/uploads/sites/3/2022/09/34213-scaled-e1688989522207.jpg"],
  ["Hightail", "https://www.calumetfarm.com/wp-content/uploads/2019/10/Hightail.png"],
  ["Ransom the Moon", "https://www.calumetfarm.com/wp-content/uploads/2019/11/RansomTheMoon2.png"],
  ["Into Mischief", "https://www.spendthriftfarm.com/wp-content/uploads/2018/11/Into-Mischief-2.png"],
  ["Temple City", "https://www.spendthriftfarm.com/wp-content/uploads/2018/11/Temple-City.png"],
  ["Baeza", "https://www.spendthriftfarm.com/wp-content/uploads/2026/08/yearling-baeza.jpg"],
  ["Liam's Map", "https://www.lanesend.com/sites/default/files/inline-images/LiamsMap-Gallery-4-optimized.jpg"],
  ["Mineshaft", "https://www.lanesend.com/sites/default/files/inline-images/Mineshaft-Gallery-9-optimized.jpg"],
  ["Tonalist", "https://www.lanesend.com/sites/default/files/inline-images/Tonalist-Gallery-6-optimized.jpg"],
  ["Not This Time", "https://www.taylormadestallions.com/wp-content/uploads/2023/08/Not-This-Time.png"],
  ["Tiz the Law", "https://media.coolmore.com/uploads/2025/10/Tiz-The-Law.jpg"],
  ["Knicks Go", "https://www.taylormadestallions.com/wp-content/uploads/2023/08/Knicks-Go.png"],
  ["Tacitus", "https://www.taylormadestallions.com/wp-content/uploads/2023/08/Tacitus.png"],
];

export async function conformationPhotoFor(name: string): Promise<{ pageUrl: string | null; photoUrl: string | null }> {
  const pageUrl = farmPageFor(name);
  const verified = VERIFIED_CONFORMATION_PHOTOS.find(([n]) => key(n) === key(name));
  if (verified) return { pageUrl, photoUrl: verified[1] };
  if (!pageUrl) return { pageUrl: null, photoUrl: null };
  const cached = cache.get(pageUrl);
  if (cached && Date.now() - cached.at < TTL_MS) return { pageUrl, photoUrl: cached.value };
  let photoUrl: string | null = null;
  let answered = false;
  // Un 429/5xx del haras (límite de pedidos, caída) no es "no hay foto":
  // se reintenta una vez y, si sigue fallando, NO se guarda en caché.
  for (let attempt = 0; attempt < 2 && !answered; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const response = await fetch(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        photoUrl = pickConformationPhoto(await response.text(), pageUrl, name);
        answered = true;
      } else if (response.status === 404 || response.status === 410) {
        answered = true;
      }
    } catch {
      /* sin red o página caída: se reintenta */
    }
  }
  if (!answered) return { pageUrl, photoUrl: null };
  cache.set(pageUrl, { at: Date.now(), value: photoUrl });
  return { pageUrl, photoUrl };
}
