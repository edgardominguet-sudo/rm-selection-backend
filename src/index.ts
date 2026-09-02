import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./api/routes";
import { requireApiKey } from "./api/auth";
import { startScheduler, startNightlySyncScheduler, startLivePriceScheduler } from "./scheduler";
import { db } from "./db";
import { getReferenceHorse } from "./referenceHorse";
import { getOrComputeReferenceCalibration } from "./analysis/referenceCalibration";
import { fetchAndDownscale } from "./analysis/imageDownscale";
import { extractLandmarksFromPhoto } from "./analysis/landmarkVisionClient";
import { evaluateFrontalFindings } from "./analysis/rmPriorityRules";
import { scoreView } from "./analysis/scoringEngine";
import { ViewLandmarks } from "./analysis/landmarks";
import { CLASSIFICATION_THRESHOLDS } from "./analysis/conformationScores";
import { extractFasigTiptonSaleId } from "./saleHouses/fasigTiptonIdAutoResolver";
import { diagRouter } from "./api/diagRoutes";
import { attachRealtime } from "./realtime";

const app = express();
// CORRECCIÓN DE RAÍZ (2026-09-02, "SINCRONIZACIÓN REAL iPHONE ↔️ iPAD" —
// bug real reportado por Ramon: favoritos/notas/fotos tomados en un
// dispositivo no aparecían en el otro). Causa raíz encontrada con
// evidencia real de los logs de Railway: Express genera por defecto un
// ETag débil para cada respuesta JSON, y GET /api/v1/me/decisions,
// /me/observations y /me/pedigree-annotations se piden con la MISMA url
// exacta (mismo query "since") en cada ciclo de sondeo (cada 6-30s,
// SyncEngine.pullDecisions/pullObservations/pullPedigreeAnnotations)
// mientras no aparece nada nuevo. El caché HTTP nativo de iOS
// (URLCache/CFNetwork, activo por defecto en URLSession.shared) queda
// habilitado para revalidar esa url contra ese ETag — y en los logs de
// Railway se ve tráfico real 304 en exactamente esas tres rutas. Un 304
// nunca debería poder salir de un endpoint de sondeo que decide
// "novedades desde since": la app tiene que recibir SIEMPRE una
// respuesta fresca del servidor, nunca una servida desde caché local del
// dispositivo. Se desactiva ETag globalmente (no hay ninguna ruta en esta
// API pensada para cachearse) y se fuerza Cache-Control: no-store en
// TODA la API autenticada — ver el middleware agregado más abajo, justo
// antes de montar `router`/`diagRouter`. Puramente aditivo: ninguna ruta
// ni lógica de negocio cambia, solo se le prohíbe a cualquier capa
// intermedia (caché de iOS, proxy) guardar o reutilizar una respuesta.
app.set("etag", false);
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

// DIAGNÓSTICO TEMPORAL (2026-08-18) — prueba puntual del resolver de ID de
// Fasig-Tipton (ver saleHouses/fasigTiptonIdAutoResolver.ts) contra una URL
// real, sin tocar ninguna venta en la base. Montado ANTES de requireApiKey
// (mismo criterio que /_diag/frontalrepeat/* arriba) para poder probarlo
// directo desde el navegador sin necesitar la x-api-key. Se borra apenas
// se confirme el resolver funcionando en producción.
app.post("/_diag/resolve-fasig-id", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) {
    res.status(400).json({ error: "Falta url." });
    return;
  }
  try {
    const startedAt = Date.now();
    const saleId = await extractFasigTiptonSaleId(url);
    res.json({ ok: true, url, saleId, ms: Date.now() - startedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[_diag/resolve-fasig-id] Error:", err);
    res.status(500).json({ error: message });
  }
});

// DIAGNÓSTICO TEMPORAL (2026-08-21) — pedido explícito de Ramon: lista
// maestra de padrillos (sire) de todos los Hips YA IMPORTADOS de una venta
// puntual, sin omitir ninguno — base real para la tarea de Stud Fees de
// Keeneland September 2026 (house=KEENELAND, externalSaleId="12"). Devuelve
// nombre de padrillo + cantidad de Hips con ese padrillo (ordenado
// alfabéticamente) y cuántos Hips quedaron sin padrillo registrado (sire
// null/vacío) para que la lista maestra sea auditable, no una suposición.
// Solo LECTURA, montado ANTES de requireApiKey (mismo criterio que el resto
// de /_diag/*). Se borra apenas se entregue la tabla de Stud Fees.
app.get("/_diag/sires", async (req, res) => {
  try {
    const house = typeof req.query.house === "string" ? req.query.house.toUpperCase() : "KEENELAND";
    const externalSaleId = typeof req.query.externalSaleId === "string" ? req.query.externalSaleId : "12";
    const hips = await db.hip.findMany({
      where: { sale: { house: house as any, externalSaleId } },
      select: { hipNumber: true, sire: true },
    });
    const counts: Record<string, number> = {};
    let missing = 0;
    for (const hip of hips) {
      const sire = hip.sire?.trim();
      if (!sire) {
        missing += 1;
        continue;
      }
      counts[sire] = (counts[sire] ?? 0) + 1;
    }
    const sires = Object.entries(counts)
      .map(([name, hipCount]) => ({ name, hipCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      house,
      externalSaleId,
      totalHips: hips.length,
      totalSires: sires.length,
      hipsWithoutSire: missing,
      sires,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[_diag/sires] Error:", err);
    res.status(500).json({ error: message });
  }
});

// DIAGNÓSTICO TEMPORAL (2026-08-19, tarde) — Ramon reporta que la
// puntuación de Análisis IA solo aparece en el dispositivo que tomó la
// foto, no en el otro, para el Hip número "1" de la venta que tiene
// abierta. Solo LECTURA: para cada Hip con hipNumber="1" (puede haber uno
// por venta), muestra su identidad (house/externalSaleId, necesarios para
// que ambos dispositivos resuelvan el mismo backendHipId) y si existe un
// AnalysisResult oficial vigente (CurrentHipAnalysis) guardado en el
// servidor. Se borra apenas se confirme la causa real.
app.get("/_diag/hip-analysis-status", async (req, res) => {
  try {
    const hipNumber = typeof req.query.hipNumber === "string" ? req.query.hipNumber : "1";
    const hips = await db.hip.findMany({
      where: { hipNumber },
      select: {
        id: true,
        hipNumber: true,
        horseName: true,
        saleId: true,
        sale: { select: { name: true, house: true, externalSaleId: true } },
        currentAnalyses: {
          select: {
            updatedAt: true,
            analysisResult: {
              select: { id: true, version: true, mediaHash: true, overallScore: true, classification: true, analyzedAt: true, methodologyVersion: true },
            },
          },
        },
      },
    });
    res.json({ hipNumber, count: hips.length, hips });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Versionado desde el día uno (barato ahora, evita romper un cliente de
// iOS viejo el día que haga falta un /api/v2 — ver ARCHITECTURE.md §5).
// DIAGNOSTICO TEMPORAL bug de Pedigree (2026-08-26) - ver diagRoutes.ts.
// Ver comentario de "app.set(\"etag\", false)" más arriba — mismo fix,
// segunda mitad: sin este header, un dispositivo con conexión lenta o
// cualquier proxy intermedio igual podría decidir por heurística propia
// que una respuesta sin Cache-Control es cacheable un rato. `no-store`
// es la instrucción HTTP más fuerte que existe para decir "nunca guardes
// ni reutilices esto, en ningún lado" — correcta para el 100% de esta
// API (nada acá está pensado para servirse desde caché).
const noStoreMiddleware: express.RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
};
app.use("/api/v1/diag", requireApiKey, noStoreMiddleware, diagRouter);
app.use("/api/v1", requireApiKey, noStoreMiddleware, router);

const server = app.listen(config.port, () => {
  console.log(`[server] RM Selection backend escuchando en el puerto ${config.port}`);
  startScheduler();
  startNightlySyncScheduler();
  startLivePriceScheduler();
});

// Sincronización en tiempo real entre dispositivos (2026-09-01) — ver
// src/realtime.ts para el diseño completo. Se monta sobre el mismo
// `server` HTTP que ya levantó Express arriba, así que comparte puerto sin
// configuración adicional en Railway.
attachRealtime(server);

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
