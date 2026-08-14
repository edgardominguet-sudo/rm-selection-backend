import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./api/routes";
import { requireApiKey } from "./api/auth";
import { startScheduler, startDiscoveryScheduler } from "./scheduler";
import { db } from "./db";

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

// DIAGNÓSTICO TEMPORAL (2026-08-14, se retira al terminar la tarea de
// Keeneland — ver convención ya usada para /diag/* en commits previos):
// prueba controlada de un puñado de Hips reales vía el mecanismo de
// respaldo por PDF de pedigree, SIN tocar la base de datos — para
// verificar sire/dam/damSire/sexo/color/consignor/foalYear antes de
// correr la importación completa (pedido explícito del propietario,
// punto 8: "no realices inmediatamente una modificación masiva").
app.get("/diag/keeneland-pdf-probe", async (req, res) => {
  const { probeKeenelandCatalogViaPedigreePdfs, fetchPedigreePdfText, parseKeenelandPedigreePdfText, DEBUG_REGEXES } = await import("./saleHouses/keenelandPedigreePdfCatalog");
  const saleCode = (req.query.saleCode as string | undefined) ?? "k226";
  const startAt = Number(req.query.startAt ?? "1");
  const count = Number(req.query.count ?? "3");
  if (req.query.raw === "1") {
    const text = await fetchPedigreePdfText(saleCode, startAt);
    res.type("text/plain").send(text ?? "(no encontrado)");
    return;
  }
  if (req.query.debug === "1") {
    const text = await fetchPedigreePdfText(saleCode, startAt);
    if (!text) {
      res.json({ ok: false, error: "PDF no encontrado" });
      return;
    }
    const damIdx = text.indexOf("1st dam");
    const around = damIdx >= 0 ? text.slice(damIdx, damIdx + 80) : null;
    res.json({
      ok: true,
      textLength: text.length,
      damIdx,
      // JSON.stringify escapa cualquier caracter invisible/no-ASCII ( , \f, etc.)
      // que el render de texto plano podría estar ocultando.
      aroundDamJson: around ? JSON.stringify(around) : null,
      parsed: parseKeenelandPedigreePdfText(text, startAt),
      regexTests: {
        damLine: DEBUG_REGEXES.DAM_LINE.test(text),
        sireLine: DEBUG_REGEXES.SIRE_LINE.test(text),
      },
    });
    return;
  }
  try {
    const hips = await probeKeenelandCatalogViaPedigreePdfs(saleCode, {
      startAt,
      hardCap: startAt + count - 1,
      maxConsecutiveMisses: count + 5,
      concurrency: 3,
    });
    res.json({ ok: true, saleCode, startAt, count, found: hips.length, hips });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// DIAGNÓSTICO TEMPORAL (2026-08-14, se retira junto con el resto de /diag/*
// al terminar la tarea de Keeneland): corre syncCatalog() REAL (el mismo
// camino que usa el scheduler normal y el endpoint autenticado
// /api/v1/sales/resync) contra la fila real de Sale — persiste en Postgres,
// a diferencia de /diag/keeneland-pdf-probe que nunca toca la base. Se
// agrega acá sin auth solo porque no tengo forma segura de leer
// APP_API_KEY desde este entorno para llamar al endpoint ya protegido; la
// lógica invocada es exactamente la misma (mismo upsert idempotente por
// [saleId, hipNumber], ver upsertNormalizedHips en rankingService.ts — no
// hay riesgo de duplicados por llamarlo más de una vez).
// El probe completo de ~4.635 Hips reales (concurrencia acotada a propósito,
// ver comentario de PedigreePdfProbeOptions.concurrency) tarda bastante más
// que cualquier timeout razonable de request HTTP — así que este endpoint
// dispara syncCatalog() en segundo plano y responde AL TOQUE con
// started:true. El progreso se consulta aparte con
// /diag/keeneland-force-sync-status.
let keenelandForceSyncState: {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: unknown;
} = { running: false, startedAt: null, finishedAt: null, error: null, result: null };

app.get("/diag/keeneland-force-sync", async (req, res) => {
  const { db } = await import("./db");
  const { syncCatalog } = await import("./rankingService");
  const { CatalogNotYetPublishedError } = await import("./types");
  const externalSaleId = (req.query.externalSaleId as string | undefined) ?? "12";
  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: "KEENELAND", externalSaleId } } });
  if (!sale) {
    res.status(404).json({ ok: false, error: `No existe ninguna Sale KEENELAND con externalSaleId=${externalSaleId}.` });
    return;
  }
  if (keenelandForceSyncState.running) {
    res.json({ ok: true, alreadyRunning: true, state: keenelandForceSyncState });
    return;
  }
  const hipCountBefore = await db.hip.count({ where: { saleId: sale.id } });
  keenelandForceSyncState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null };
  res.json({ ok: true, started: true, saleName: sale.name, saleId: sale.id, hipCountBefore });

  // Corre en segundo plano — la respuesta HTTP ya se mandó arriba.
  (async () => {
    try {
      await syncCatalog(sale);
      const hipCountAfter = await db.hip.count({ where: { saleId: sale.id } });
      const allHipNumbers = await db.hip.findMany({ where: { saleId: sale.id }, select: { hipNumber: true } });
      const numericHipNumbers = allHipNumbers.map((h) => Number(h.hipNumber)).filter((n) => Number.isFinite(n));
      const minHipNumber = numericHipNumbers.length > 0 ? Math.min(...numericHipNumbers) : null;
      const maxHipNumber = numericHipNumbers.length > 0 ? Math.max(...numericHipNumbers) : null;
      keenelandForceSyncState = {
        running: false,
        startedAt: keenelandForceSyncState.startedAt,
        finishedAt: new Date().toISOString(),
        error: null,
        result: { hipCountBefore, hipCountAfter, newHips: hipCountAfter - hipCountBefore, minHipNumber, maxHipNumber },
      };
      console.log(`[diag/keeneland-force-sync] Completo: ${hipCountBefore} -> ${hipCountAfter} Hips (rango ${minHipNumber}-${maxHipNumber}).`);
    } catch (err) {
      const message = err instanceof CatalogNotYetPublishedError ? err.message : String(err);
      keenelandForceSyncState = {
        running: false,
        startedAt: keenelandForceSyncState.startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
        result: null,
      };
      console.error("[diag/keeneland-force-sync] Error en segundo plano:", err);
    }
  })();
});

app.get("/diag/keeneland-force-sync-status", (_req, res) => {
  res.json(keenelandForceSyncState);
});

// Versionado desde el día uno (barato ahora, evita romper un cliente de
// iOS viejo el día que haga falta un /api/v2 — ver ARCHITECTURE.md §5).
app.use("/api/v1", requireApiKey, router);

const server = app.listen(config.port, () => {
  console.log(`[server] RM Selection backend escuchando en el puerto ${config.port}`);
  startScheduler();
  startDiscoveryScheduler();
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
