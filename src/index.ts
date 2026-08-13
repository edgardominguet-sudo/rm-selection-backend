import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./api/routes";
import { requireApiKey } from "./api/auth";
import { startScheduler, startDiscoveryScheduler } from "./scheduler";
import { db } from "./db";
import { syncCatalog } from "./rankingService";

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

// DIAGNÓSTICO TEMPORAL (2026-08-13) — sin autenticación a propósito, mismo
// criterio que /health: solo lectura, solo datos de catálogo ya públicos
// (nombre/fecha de venta), CERO datos sensibles ni de usuarios. Se agrega
// para verificar el estado de Fasig-Tipton Saratoga y la nueva tabla
// OfficialSaleResult recién desplegada, y se saca en el próximo commit.
app.get("/diag/official-sale-result-check", async (_req, res) => {
  const sales = await db.sale.findMany({
    where: { name: { contains: "Saratoga", mode: "insensitive" } },
    select: {
      id: true, house: true, name: true, externalSaleId: true, startDate: true,
      isActive: true, catalogAccess: true, lastCatalogCheckAt: true,
    },
    orderBy: { startDate: "desc" },
  });
  const officialCount = await db.officialSaleResult.count();
  const sample = await db.officialSaleResult.findMany({ take: 5 });
  const hipCountBySale = await Promise.all(
    sales.map(async (s) => ({ saleId: s.id, hipCount: await db.hip.count({ where: { saleId: s.id } }) }))
  );
  res.json({ sales, officialCount, sample, hipCountBySale });
});

// DIAGNÓSTICO TEMPORAL (2026-08-13) — fuerza un resync inmediato de la
// venta real de Fasig-Tipton Saratoga (id fijo, no un parámetro libre, a
// propósito: no se convierte en un disparador genérico de resync sin
// autenticación) contra la API oficial, para poder confirmar en el acto
// que OfficialSaleResult se está poblando con datos reales. Se saca en el
// próximo commit, igual que el endpoint de arriba.
app.get("/diag/resync-saratoga", async (_req, res) => {
  const saleId = "cmsq3e89e001rehngdb21dnmz";
  const sale = await db.sale.findUnique({ where: { id: saleId } });
  if (!sale) {
    res.status(404).json({ error: "sale not found" });
    return;
  }
  try {
    await syncCatalog(sale);
  } catch (err) {
    res.status(500).json({ error: String(err) });
    return;
  }
  const officialCount = await db.officialSaleResult.count();
  const sample = await db.officialSaleResult.findMany({ take: 15, orderBy: { hipNumber: "asc" } });
  const rawHipSample = await db.hip.findMany({
    where: { saleId },
    select: { hipNumber: true, saleResultJson: true },
    orderBy: { hipNumber: "asc" },
    take: 20,
  });
  res.json({ synced: true, officialCount, sample, rawHipSample });
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
