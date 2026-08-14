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
// motor nuevo de Análisis Anatómico: corre analyzeHip() DOS VECES sobre
// exactamente las mismas fotos (sin pasar por el cache de mediaHash de
// rankingService, a propósito, para forzar que la IA se llame de verdad
// las 2 veces) y devuelve ambos resultados para comparar. NO escribe
// nada en AnalysisResult (no ensucia el historial real). Se borra apenas
// termine la prueba.
app.get("/_diag/reproducibility-test", async (_req, res) => {
  try {
    let hipNumber: string;
    let horseName: string | undefined;
    let organizationId: string;
    let media: { kind: "photo"; url: string }[];

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
        hipNumber = hip.hipNumber;
        horseName = hip.horseName ?? undefined;
        organizationId = asset.organizationId;
        media = assets.map((a) => ({ kind: "photo" as const, url: resolveReadUrl(a.storageKey) }));
      } else {
        res.json({ found: false, reason: `No hay ningún Hip con las 3 fotos AI_ANALYSIS_PHOTO todavía (encontrado: ${assets.length}).`, fallbackAttempted: false });
        return;
      }
    } else {
      // FALLBACK: todavía no hay ningún Hip con fotos de Análisis IA
      // cargadas — se usan las 3 fotos del propio caballo referente como
      // sujeto de prueba. No dice nada sobre la CALIDAD del análisis
      // (comparar al referente contra sí mismo no es representativo),
      // pero SÍ ejercita el pipeline completo de punta a punta
      // (extracción de landmarks real vía Claude + geometría +
      // severidad + score) para medir reproducibilidad, que es lo único
      // que esta prueba necesita confirmar.
      const orgRow = await db.referenceHorse.findFirst({ where: { key: "default" } });
      if (!orgRow || !orgRow.lateralPhotoUrl || !orgRow.frontalPhotoUrl || !orgRow.posteriorPhotoUrl) {
        res.json({ found: false, reason: "No hay ningún Hip con fotos de Análisis IA, y tampoco hay caballo referente configurado para usar como fallback." });
        return;
      }
      hipNumber = "TEST-REFERENCE-SELF";
      horseName = "Prueba de reproducibilidad (caballo referente)";
      organizationId = orgRow.organizationId;
      media = [
        { kind: "photo", url: orgRow.lateralPhotoUrl },
        { kind: "photo", url: orgRow.frontalPhotoUrl },
        { kind: "photo", url: orgRow.posteriorPhotoUrl },
      ];
    }

    const reference = await getReferenceHorse(organizationId);
    const run1 = await analyzeHip({ hipNumber, horseName, organizationId, media, reference });
    const run2 = await analyzeHip({ hipNumber, horseName, organizationId, media, reference });

    res.json({
      found: true,
      hipNumber,
      organizationId,
      run1: { scores: run1.scores, summary: run1.summary },
      run2: { scores: run2.scores, summary: run2.summary },
      scoresIdentical: JSON.stringify(run1.scores) === JSON.stringify(run2.scores),
      summaryIdentical: run1.summary === run2.summary,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  }
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
