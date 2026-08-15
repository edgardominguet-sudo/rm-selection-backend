import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./api/routes";
import { requireApiKey } from "./api/auth";
import { startScheduler, startDiscoveryScheduler, startMediaSweepScheduler } from "./scheduler";
import { db } from "./db";
import { getReferenceHorse } from "./referenceHorse";
import { getOrComputeReferenceCalibration } from "./analysis/referenceCalibration";
import { fetchAndDownscale } from "./analysis/imageDownscale";
import { extractLandmarksFromPhoto } from "./analysis/landmarkVisionClient";
import { evaluateFrontalFindings } from "./analysis/rmPriorityRules";
import { scoreView } from "./analysis/scoringEngine";
import { ViewLandmarks } from "./analysis/landmarks";
import { CLASSIFICATION_THRESHOLDS } from "./analysis/conformationScores";

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

// DIAGNÓSTICO TEMPORAL (2026-08-14, tarde) — prueba de repetibilidad
// pedida por Ramon ESPECÍFICAMENTE sobre Frontal tras la corrección de
// baseWidthRatio: extrae landmarks de la MISMA foto frontal del
// referente N veces seguidas (1 sola llamada a IA por corrida — no 3,
// ya que lateral/posterior no cambiaron y no hace falta repetirlos) y
// registra score, categoría y baseWidthRatio crudo de cada corrida. Se
// borra apenas se documenten los resultados en el reporte a Ramon.
function classifyViewScore(score: number): "Excelente" | "Bien" | "Revisar" {
  if (score >= CLASSIFICATION_THRESHOLDS.excelenteMinimo) return "Excelente";
  if (score >= CLASSIFICATION_THRESHOLDS.bienMinimo) return "Bien";
  return "Revisar";
}

const frontalRepeatResults: Record<
  string,
  { status: "running" | "done" | "error"; completedRuns?: number; totalRuns?: number; data?: unknown; error?: string }
> = {};

app.get("/_diag/frontalrepeat/start/:slot", async (req, res) => {
  const slot = req.params.slot;
  const n = Math.max(1, Math.min(15, Number(req.query.n) || 10));
  frontalRepeatResults[slot] = { status: "running", completedRuns: 0, totalRuns: n };
  res.json({ started: true, slot, totalRuns: n });
  (async () => {
    try {
      const orgRow = await db.referenceHorse.findFirst({ where: { key: "default" } });
      if (!orgRow || !orgRow.frontalPhotoUrl) {
        frontalRepeatResults[slot] = { status: "error", error: "No hay foto frontal del referente configurada." };
        return;
      }
      const reference = await getReferenceHorse(orgRow.organizationId);
      const calibration = await getOrComputeReferenceCalibration(orgRow.organizationId, reference);
      const referenceMetrics = calibration?.referenceMetrics?.frontal;
      const jpeg = await fetchAndDownscale(orgRow.frontalPhotoUrl);
      if (!jpeg) {
        frontalRepeatResults[slot] = { status: "error", error: "No se pudo descargar la foto frontal del referente." };
        return;
      }
      const runs: Array<{
        runIndex: number;
        score: number;
        classification: string;
        baseWidthRatio: number | null;
        findings: Array<{ defectId: string; severity: string; side?: string; measuredValue: number }>;
        landmarks?: Record<string, unknown>;
      }> = [];
      const debugLandmarkIds = [
        "shoulderLeft",
        "shoulderRight",
        "carpusLeft",
        "carpusRight",
        "fetlockLeft",
        "fetlockRight",
        "hoofCenterLeft",
        "hoofCenterRight",
        "hoofToeLeft",
        "hoofToeRight",
        "hoofHeelLeft",
        "hoofHeelRight",
        "hoofMedialLeft",
        "hoofMedialRight",
        "hoofLateralLeft",
        "hoofLateralRight",
      ];
      for (let i = 0; i < n; i++) {
        const extraction = await extractLandmarksFromPhoto({
          jpeg,
          photoLabel: `Prueba repetibilidad Frontal #${i + 1}`,
          expectedView: "frontal",
        });
        if (!extraction.valid || extraction.view !== "frontal") {
          runs.push({ runIndex: i + 1, score: 0, classification: "error-extraccion", baseWidthRatio: null, findings: [] });
        } else {
          const { findings, rawMetrics } = evaluateFrontalFindings(
            extraction.landmarks as ViewLandmarks<"frontal">,
            extraction.overallConfidence,
            referenceMetrics
          );
          const viewScore = scoreView(findings);
          const landmarksOut: Record<string, unknown> = {};
          for (const id of debugLandmarkIds) {
            if (extraction.landmarks[id]) landmarksOut[id] = extraction.landmarks[id];
          }
          runs.push({
            runIndex: i + 1,
            score: viewScore.score,
            classification: classifyViewScore(viewScore.score),
            baseWidthRatio: rawMetrics.baseWidthRatio ?? null,
            findings: findings.map((f) => ({ defectId: f.defectId, severity: f.severity, side: f.side, measuredValue: f.measuredValue })),
            landmarks: landmarksOut,
          });
        }
        frontalRepeatResults[slot] = { status: "running", completedRuns: i + 1, totalRuns: n };
      }
      frontalRepeatResults[slot] = { status: "done", completedRuns: n, totalRuns: n, data: { runs } };
    } catch (err) {
      frontalRepeatResults[slot] = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  })();
});

app.get("/_diag/frontalrepeat/result/:slot", (req, res) => {
  res.json(frontalRepeatResults[req.params.slot] ?? { status: "not_started" });
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
