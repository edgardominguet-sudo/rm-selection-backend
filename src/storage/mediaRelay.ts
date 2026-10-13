import { createHmac, timingSafeEqual } from "crypto";
import express, { Request, Response } from "express";
import { db } from "../db";
import { config } from "../config";
import { createUploadUrl } from "./r2Client";

/**
 * SUBIDA DE FOTOS A TRAVÉS DEL SERVIDOR (2026-10-13, causa raíz de "no se
 * están realizando los análisis"): el iPad subía cada foto DIRECTO a
 * Cloudflare R2 (`<cuenta>.r2.cloudflarestorage.com`). En la red de la venta
 * ese dominio no resolvía ("A server with the specified hostname could not
 * be found" / "The request timed out") mientras el servidor sí respondía:
 * la foto nunca llegaba y el análisis fallaba con "no hay fotos".
 *
 * Ahora la URL de subida apunta a ESTE servidor (mismo dominio que ya usa
 * toda la app); el servidor reenvía el archivo a R2 desde Railway, que
 * siempre llega. La app no cambia: sigue haciendo el mismo PUT a la
 * `uploadUrl` que recibe. La URL lleva una firma con vencimiento (no
 * requiere x-api-key, igual que una URL prefirmada de R2).
 */

const RELAY_TTL_SECONDS = 900;
/** Fotos/PDF: tamaño máximo aceptado por el relé (los videos siguen directo a R2). */
export const RELAY_MAX_BYTES = "40mb";
const RELAY_KINDS = new Set(["PHOTO", "AI_ANALYSIS_PHOTO", "PEDIGREE_CHART", "VET_REPORT"]);

function secret(): string {
  return process.env.APP_API_KEY || config.r2SecretAccessKey || "rm-selection-media-relay";
}

function sign(id: string, exp: number): string {
  return createHmac("sha256", secret()).update(`${id}.${exp}`).digest("hex");
}

export function shouldRelay(kind: string | undefined): boolean {
  return !!kind && RELAY_KINDS.has(kind);
}

/** URL de subida vía servidor para un MediaAsset (misma forma de uso que la prefirmada de R2). */
export function createRelayUploadUrl(req: Request, mediaAssetId: string): string {
  const exp = Math.floor(Date.now() / 1000) + RELAY_TTL_SECONDS;
  const host = req.get("host") ?? "";
  const scheme = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${scheme}://${host}/api/v1/media-relay/${encodeURIComponent(mediaAssetId)}?exp=${exp}&sig=${sign(mediaAssetId, exp)}`;
}

function validSignature(id: string, expRaw: unknown, sigRaw: unknown): boolean {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  if (typeof sigRaw !== "string" || !/^[0-9a-f]{64}$/.test(sigRaw)) return false;
  const expected = Buffer.from(sign(id, exp), "hex");
  const given = Buffer.from(sigRaw, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const mediaRelayBodyParser = express.raw({ type: () => true, limit: RELAY_MAX_BYTES });

export async function handleMediaRelayUpload(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  if (!validSignature(id, req.query.exp, req.query.sig)) {
    res.status(403).json({ error: "Firma de subida inválida o vencida." });
    return;
  }
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.deletedAt) {
    res.status(404).json({ error: "MediaAsset no encontrado." });
    return;
  }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: "Archivo vacío." });
    return;
  }
  const contentType = req.get("content-type") || asset.contentType || "application/octet-stream";
  const target = createUploadUrl(asset.storageKey);
  const started = Date.now();
  const upstream = await fetch(target, { method: "PUT", body, headers: { "Content-Type": contentType } });
  if (!upstream.ok) {
    console.log(`[media-relay] ${id}: R2 respondió ${upstream.status}`);
    res.status(502).json({ error: `Almacenamiento respondió ${upstream.status}.` });
    return;
  }
  console.log(`[media-relay] ${id}: ${body.length} bytes subidos a R2 en ${Date.now() - started} ms`);
  res.status(200).end();
}
