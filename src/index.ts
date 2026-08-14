import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./api/routes";
import { requireApiKey } from "./api/auth";
import { startScheduler, startDiscoveryScheduler, startMediaSweepScheduler } from "./scheduler";
import { db } from "./db";
import { analyzeHip } from "./analysis/anthropicClient";
import { getReferenceHorse } from "./referenceHorse";
import { resolveReadUrl } from "./storage/r2Client";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Health check sin autenticación, montado ANTES del middleware de API key
// — Railway (y cualquier monitor externo) tiene que poder confirmar que
// el servicio está vivo sin conocer la clave privada de la app.
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Sirve las fotos del caballo referente SIN autenticación — a propósito,
// montado ANTES de requireApiKey (Tarea 1, 2026-08-10). analyzeHip hace
// un fetch(url) del lado del servidor sin ningún header propio (igual que
// con cualquier foto de catálogo de una casa de ventas), así que esta
// ruta puntual no puede exigir x-api-key o el análisis nunca podría leer
// sus propias fotos. El id es un cuid impredecible — ver
// ReferenceHorsePhoto en schema.prisma y el POST protegido en routes.ts.
app.get("/api/v1/reference-horse/photos/:id", async (req, res) => {
  const photo = await db.referenceHorsePhoto.findUnique({ where: { id: req.params.id } });
  if (!photo) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", photo.mimeType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(Buffer.from(photo.dataBase64, "base64"));
});

// DIAGNÓSTICO TEMPORAL (2026-08-14) — prueba de reproducibilidad del
// motor nuevo de Análisis Anatómico: corre analyzeHip() sobre las mismas
// fotos, en dos slots separados (para no atar la corrida completa —
// varias llamadas secuenciales a Claude — a una sola request HTTP y
// pisar el timeout del proxy). GET .../start/:slot dispara la corrida en
// segundo plano y responde al toque; GET .../result/:slot devuelve el
// resultado cuando esté listo. NO escribe nada en AnalysisResult. Se
// borra apenas termine la prueba.
const reproTestResults: Record<string, { status: "running" | "done" | "error"; data?: unknown; error?: string }> = {};

async function resolveReproTestSubject(): Promise<{ hipNumber: string; horseName?: string; organizationId: string; media: { kind: "photo"; url: string }[] } | { error: string }> {
  const asset = await db.mediaAsset.findFirst({
    where: { kind: "AI_ANALYSIS_PHOTO", uploadStatus: "PROCESSED", deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (asset) {
    const hip = await db.hip.findUnique({ where: { id: asset.hipId } });
    const assets = hip
      ? await db.mediaAsset.findMany({
          where: { hipId: hip.id, organizationId: asset.organizationId, kind: "AI_ANALYSIS_PHOTO", uploadStatus: "PROCESSED", deletedAt: null },
          orderBy: { createdAt: "asc" },
        })
      : [];
    if (hip && assets.length >= 3) {
      return {
        hipNumber: hip.hipNumber,
        horseName: hip.horseName ?? undefined,
        organizationId: asset.organizationId,
        media: assets.map((a) => ({ kind: "photo" as const, url: resolveReadUrl(a.storageKey) })),
      };
    }
    return { error: `No hay ningún Hip con las 3 fotos AI_ANALYSIS_PHOTO todavía (encontrado: ${assets.length}).` };
  }
  // FALLBACK: todavía no hay ningún Hip con fotos de Análisis IA cargadas
  // — se usan las 3 fotos del propio caballo referente como sujeto de
  // prueba. No dice nada sobre la CALIDAD del análisis (comparar al
  // referente contra sí mismo no es representativo), pero SÍ ejercita el
  // pipeline completo de punta a punta para medir reproducibilidad.
  const orgRow = await db.referenceHorse.findFirst({ where: { key: "default" } });
  if (!orgRow || !orgRow.lateralPhotoUrl || !orgRow.frontalPhotoUrl || !orgRow.posteriorPhotoUrl) {
    return { error: "No hay ningún Hip con fotos de Análisis IA, y tampoco hay caballo referente configurado para usar como fallback." };
  }
  return {
    hipNumber: "TEST-REFERENCE-SELF",
    horseName: "Prueba de reproducibilidad (caballo referente)",
    organizationId: orgRow.organizationId,
    media: [
      { kind: "photo", url: orgRow.lateralPhotoUrl },
      { kind: "photo", url: orgRow.frontalPhotoUrl },
      { kind: "photo", url: orgRow.posteriorPhotoUrl },
    ],
  };
}

app.get("/_diag/repro/start/:slot", async (req, res) => {
  const slot = req.params.slot;
  reproTestResults[slot] = { status: "running" };
  res.json({ started: true, slot });
  (async () => {
    try {
      const subject = await resolveReproTestSubject();
      if ("error" in subject) {
        reproTestResults[slot] = { status: "error", error: subject.error };
        return;
      }
      const reference = await getReferenceHorse(subject.organizationId);
      const outcome = await analyzeHip({
        hipNumber: subject.hipNumber,
        horseName: subject.horseName,
        organizationId: subject.organizationId,
        media: subject.media,
        reference,
      });
      reproTestResults[slot] = {
        status: "done",
        data: { hipNumber: subject.hipNumber, scores: outcome.scores, summary: outcome.summary },
      };
    } catch (err) {
      reproTestResults[slot] = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  })();
});

app.get("/_diag/repro/result/:slot", (req, res) => {
  res.json(reproTestResults[req.params.slot] ?? { status: "not_started" });
});

// Versionado desde el día uno (barato ahora, evita romper un cliente de
// iOS viejo el día que haga falta un /api/v2 — ver ARCHITECTURE.md §5).
app.use("/api/v1", requireApiKey, router);

const server = app.listen(config.port, () => {
  console.log(`[server] RM Selection backend escuchando en el puerto ${config.port}`);
  startScheduler();
  startDiscoveryScheduler();
  startMediaSweepScheduler();
});

// Railway manda SIGTERM antes de matar el contenedor en cada redeploy —
// sin esto, un análisis a mitad de camino o una conexión a Postgres
// abierta se cortarían de golpe en vez de cerrarse limpio.
function shutdown(signal: string) {
  console.log(`[server] Recibido ${signal}, cerrando de forma prolija…`);
  server.close(() => {
    db.$disconnect().finally(() => process.exit(0));
  });
  // Si algo no cierra a tiempo, no dejamos el proceso colgado para siempre.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
