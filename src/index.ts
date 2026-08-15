import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./api/routes";
import { requireApiKey } from "./api/auth";
import { startScheduler, startDiscoveryScheduler, startMediaSweepScheduler } from "./scheduler";
import { db } from "./db";
import { analyzeHip, AnalysisOutcome } from "./analysis/anthropicClient";
import { getReferenceHorse } from "./referenceHorse";

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

// DIAGNÓSTICO TEMPORAL (2026-08-14) — prueba CONTROLADA de
// reproducibilidad pedida por Ramon: correr analyzeHip() N veces
// SEGUIDAS sobre exactamente las mismas 3 fotografías (sin agregar
// llamadas extra por foto — solo mide la variación actual del motor tal
// como quedó después de acotar la IA a extracción de landmarks) y
// registrar, por corrida, el score de cada vista + los hallazgos +
// landmarks crudos, para poder calcular la diferencia máxima entre
// corridas y qué landmarks la causaron. Arranca en segundo plano (patrón
// start/poll, igual que la prueba anterior) para no pisar el timeout del
// proxy con N corridas secuenciales. Se borra apenas se documenten los
// resultados en el reporte a Ramon.
const multiRunResults: Record<
  string,
  { status: "running" | "done" | "error"; completedRuns?: number; totalRuns?: number; data?: unknown; error?: string }
> = {};

async function resolveMultiRunSubject(): Promise<
  { hipNumber: string; horseName?: string; organizationId: string; media: { kind: "photo"; url: string }[] } | { error: string }
> {
  // CORRECCIÓN (2026-08-14, misma tarde): la primera versión de esto
  // buscaba un Hip real con >=3 AI_ANALYSIS_PHOTO y le pasaba TODOS sus
  // assets — pero un Hip real puede acumular más de 3 fotos de Análisis
  // IA con el tiempo (reintentos, reemplazos de foto rechazada), lo cual
  // (a) viola el pedido explícito de Ramon de correr "exactamente las
  // mismas tres fotografías" en cada corrida, y (b) multiplica el tiempo
  // de cada corrida sin motivo. Usar SIEMPRE las 3 fotos fijas del
  // caballo referente — es el único conjunto garantizado de exactamente 3
  // fotos, estable entre corridas.
  const orgRow = await db.referenceHorse.findFirst({ where: { key: "default" } });
  if (!orgRow || !orgRow.lateralPhotoUrl || !orgRow.frontalPhotoUrl || !orgRow.posteriorPhotoUrl) {
    return { error: "No hay ningún Hip con fotos de Análisis IA, y tampoco hay caballo referente configurado." };
  }
  return {
    hipNumber: "TEST-MULTIRUN",
    horseName: "Prueba controlada de reproducibilidad",
    organizationId: orgRow.organizationId,
    media: [
      { kind: "photo", url: orgRow.lateralPhotoUrl },
      { kind: "photo", url: orgRow.frontalPhotoUrl },
      { kind: "photo", url: orgRow.posteriorPhotoUrl },
    ],
  };
}

app.get("/_diag/multirun/start/:slot", async (req, res) => {
  const slot = req.params.slot;
  const n = Math.max(1, Math.min(10, Number(req.query.n) || 5));
  multiRunResults[slot] = { status: "running", completedRuns: 0, totalRuns: n };
  res.json({ started: true, slot, totalRuns: n });
  (async () => {
    try {
      const subject = await resolveMultiRunSubject();
      if ("error" in subject) {
        multiRunResults[slot] = { status: "error", error: subject.error };
        return;
      }
      const reference = await getReferenceHorse(subject.organizationId);
      const runs: Array<{
        runIndex: number;
        scores: AnalysisOutcome["scores"];
        detail: AnalysisOutcome["detail"];
      }> = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        console.log(`[multirun ${slot}] corrida ${i + 1}/${n}: iniciando analyzeHip()...`);
        const outcome = await analyzeHip({
          hipNumber: subject.hipNumber,
          horseName: subject.horseName,
          organizationId: subject.organizationId,
          media: subject.media,
          reference,
        });
        console.log(`[multirun ${slot}] corrida ${i + 1}/${n}: terminada en ${Date.now() - t0}ms`);
        runs.push({ runIndex: i + 1, scores: outcome.scores, detail: outcome.detail });
        multiRunResults[slot] = { status: "running", completedRuns: i + 1, totalRuns: n };
      }
      multiRunResults[slot] = { status: "done", completedRuns: n, totalRuns: n, data: { hipNumber: subject.hipNumber, runs } };
    } catch (err) {
      multiRunResults[slot] = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  })();
});

app.get("/_diag/multirun/result/:slot", (req, res) => {
  res.json(multiRunResults[req.params.slot] ?? { status: "not_started" });
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
