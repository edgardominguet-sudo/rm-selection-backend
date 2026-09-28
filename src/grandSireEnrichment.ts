// Grand Sire (padre del Sire) — 2026-09-28, pedido de Ramon para Search.
//
// Ninguna casa publica el Grand Sire en su catálogo JSON, pero OBS publica
// el PDF de pedigree de cada HIP (`pedigree_pdf_link`) y ahí figura como
// texto. El Grand Sire es un dato del PADRILLO (el mismo para todos sus
// hijos), así que se guarda UNA vez por padrillo en `Stallion.sireName` y
// se lee UN solo PDF por padrillo que todavía no lo tenga — nunca un PDF
// por HIP. Idempotente: en la próxima sincronización solo se consultan los
// padrillos nuevos. Cada valor guarda de dónde salió (`sireNameSource`).
//
// Nunca se infiere: si el PDF no se puede leer, o si el Sire / Broodmare
// Sire del PDF no coinciden con los del catálogo, no se guarda nada y en
// Search ese Grand Sire sigue como "Not available".
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { NormalizedHip } from "./types";
import { normalizeStallionName } from "./stallionService";
import { extractVerifiedGrandSire } from "./catalogNames";

/** Tope de PDFs por corrida (una venta grande tiene ~120-250 padrillos distintos). */
const MAX_PDFS_PER_RUN = 300;
const PDF_TIMEOUT_MS = 20_000;
const MAX_CANDIDATES_PER_SIRE = 3;

export type PdfTextFetcher = (url: string) => Promise<string | null>;

/** Descarga un PDF y devuelve su texto (null si no se pudo). Mismo lector que Keeneland (pdf-parse). */
export async function fetchPdfText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PDF_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: "application/pdf" }, signal: controller.signal });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return parsed.text ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface GrandSireEnrichmentSummary {
  sires: number;
  alreadyKnown: number;
  checked: number;
  saved: number;
  unverified: number;
}

export async function enrichGrandSiresFromPedigreePdfs(
  saleName: string,
  hips: NormalizedHip[],
  fetchText: PdfTextFetcher = fetchPdfText
): Promise<GrandSireEnrichmentSummary> {
  // Hasta 3 HIPs por padrillo (con PDF; primero los que tienen Broodmare Sire
  // para verificar mejor). Si el PDF del primero no verifica, se prueba el
  // siguiente — nunca más de MAX_CANDIDATES_PER_SIRE por padrillo.
  const bySire = new Map<string, NormalizedHip[]>();
  for (const hip of hips) {
    if (!hip.sire || !hip.pedigreePdfUrl) continue;
    const key = normalizeStallionName(hip.sire);
    const list = bySire.get(key) ?? [];
    list.push(hip);
    bySire.set(key, list);
  }
  for (const list of bySire.values()) {
    list.sort((a, b) => Number(!a.damSire) - Number(!b.damSire));
    list.splice(MAX_CANDIDATES_PER_SIRE);
  }
  const summary: GrandSireEnrichmentSummary = { sires: bySire.size, alreadyKnown: 0, checked: 0, saved: 0, unverified: 0 };
  if (bySire.size === 0) return summary;

  const known = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM "Stallion" WHERE "sireName" IS NOT NULL AND btrim("sireName") <> '' AND name = ANY($1::text[])`,
    [...bySire.keys()]
  );
  const knownSet = new Set(known.map((k) => k.name));
  summary.alreadyKnown = knownSet.size;

  for (const [key, candidates] of bySire) {
    if (knownSet.has(key)) continue;
    if (summary.checked >= MAX_PDFS_PER_RUN) break;
    summary.checked += 1;
    let grandSire: string | null = null;
    let hip = candidates[0];
    for (const candidate of candidates) {
      const text = await fetchText(candidate.pedigreePdfUrl!);
      grandSire = text ? extractVerifiedGrandSire(text, { sire: candidate.sire!, damSire: candidate.damSire }) : null;
      if (grandSire) {
        hip = candidate;
        break;
      }
    }
    if (!grandSire) {
      summary.unverified += 1;
      continue;
    }
    // Solo completa un dato vacío: nunca pisa un sireName ya cargado.
    await db.$executeRawUnsafe(
      `INSERT INTO "Stallion" (id, name, "sireName", "sireNameSource", "updatedAt")
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (name) DO UPDATE
         SET "sireName" = EXCLUDED."sireName", "sireNameSource" = EXCLUDED."sireNameSource", "updatedAt" = now()
         WHERE "Stallion"."sireName" IS NULL OR btrim("Stallion"."sireName") = ''`,
      randomUUID(),
      key,
      grandSire,
      `Pedigree PDF · ${saleName} · HIP ${hip.hipNumber}`
    );
    summary.saved += 1;
  }
  return summary;
}
