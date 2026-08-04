import { Router } from "express";
import { db } from "../db";
import { setReferenceHorse, getReferenceHorse } from "../referenceHorse";
import { requireUser } from "./auth";

export const router = Router();

// Ventas dadas de alta (para que la app arme el selector inicial sin
// tener que hardcodear IDs de venta en el cliente).
router.get("/sales", async (_req, res) => {
  const sales = await db.sale.findMany({
    where: { isActive: true },
    select: { id: true, house: true, name: true },
  });
  res.json(sales);
});

/**
 * El Ranking del Día YA CALCULADO para una venta — esto es lo único que
 * llama la app de iOS al abrir la pantalla. No dispara ningún análisis:
 * si todavía no se generó (falta para la ventana de 12h antes, o la
 * venta no tiene forma de resolver el programa automáticamente), lo dice
 * explícitamente en vez de tardar.
 *
 * Se identifica la venta por house + externalSaleId (los mismos datos
 * que la app YA conoce, ver SaleOption.swift) en vez del id interno que
 * genera la base — así la app no tiene que enterarse de ningún ID nuevo
 * generado por Railway al dar de alta la venta.
 *
 * El ranking es dato PRIVADO de la organización del usuario (distintas
 * organizaciones pueden tener puntajes distintos sobre el mismo Hip, ver
 * ARCHITECTURE.md) — por eso esta ruta exige un usuario autenticado, a
 * diferencia de /sales o /reference-horse que hoy son de un solo dueño.
 * La app de iOS ya manda `x-api-key` en cada request, así que esto no
 * requiere ningún cambio del lado de iOS.
 */
router.get("/ranking", requireUser, async (req, res) => {
  const house = req.query.house as string | undefined;
  const externalSaleId = req.query.externalSaleId as string | undefined;
  const dateParam = req.query.date as string | undefined; // "YYYY-MM-DD", default hoy
  const organizationId = req.user!.organizationId;

  if (!house || !externalSaleId) {
    res.status(400).json({ error: "Faltan parámetros: house, externalSaleId." });
    return;
  }

  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: house as never, externalSaleId } } });
  if (!sale) {
    res.json({
      saleName: null,
      status: "sale_not_registered",
      entries: [],
      totalHipsToday: 0,
      generatedAt: null,
      updatedAt: null,
    });
    return;
  }
  const saleId = sale.id;

  const day = dateParam ? new Date(`${dateParam}T00:00:00Z`) : new Date();
  const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));

  const snapshot = await db.rankingSnapshot.findUnique({
    where: { organizationId_saleId_sessionDate: { organizationId, saleId, sessionDate: dayStart } },
  });

  const hasAnySessionDateResolved = await db.hip.count({ where: { saleId, sessionDate: { not: null } } });

  if (!snapshot) {
    res.json({
      saleName: sale.name,
      status: hasAnySessionDateResolved > 0 ? "not_generated_yet" : "schedule_unavailable",
      entries: [],
      totalHipsToday: 0,
      generatedAt: null,
      updatedAt: null,
    });
    return;
  }

  res.json({
    saleName: sale.name,
    status: "ready",
    entries: snapshot.entriesJson,
    totalHipsToday: snapshot.totalHipsToday,
    generatedAt: snapshot.generatedAt,
    updatedAt: snapshot.updatedAt,
  });
});

// Detalle completo de un Hip ya analizado — para que la ficha del Hip en
// la app pueda mostrar el mismo desglose de 26 subcategorías que antes
// calculaba on-device. Incluye el análisis vigente DE LA ORGANIZACIÓN del
// usuario autenticado y, si se pide con ?history=1, el historial completo
// de reanálisis de esa misma organización (ver ARCHITECTURE.md 1a).
router.get("/sales/:saleId/hips/:hipNumber", requireUser, async (req, res) => {
  const { saleId, hipNumber } = req.params;
  const includeHistory = req.query.history === "1";
  const organizationId = req.user!.organizationId;

  const hip = await db.hip.findUnique({ where: { saleId_hipNumber: { saleId, hipNumber } } });
  if (!hip) {
    res.status(404).json({ error: "Hip no encontrado." });
    return;
  }

  const pointer = await db.currentHipAnalysis.findUnique({
    where: { hipId_organizationId: { hipId: hip.id, organizationId } },
    include: { analysisResult: true },
  });
  const analysisHistory = includeHistory
    ? await db.analysisResult.findMany({ where: { hipId: hip.id, organizationId }, orderBy: { version: "desc" } })
    : undefined;

  res.json({
    ...hip,
    currentAnalysis: pointer?.analysisResult ?? null,
    ...(analysisHistory ? { analysisHistory } : {}),
  });
});

// MARK: - Decisiones y observaciones del usuario (sincronización entre
// dispositivos — ver ARCHITECTURE.md sección 3). Estas rutas ya quedan
// disponibles aunque la app de iOS todavía no las llame: cuando se haga el
// trabajo del lado de iOS para romper decisiones/observaciones en
// entidades sincronizables, el backend no va a necesitar otro deploy.

// Todo lo que cambió desde `since` (o todo si no se manda) — patrón de
// sincronización delta: el dispositivo pide "qué cambió" en vez de bajar
// todo cada vez.
router.get("/me/decisions", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const decisions = await db.userDecision.findMany({
    where: { userId: req.user!.id, ...(since ? { updatedAt: { gt: since } } : {}) },
    orderBy: { updatedAt: "asc" },
  });
  res.json(decisions);
});

router.put("/me/decisions/:hipId", requireUser, async (req, res) => {
  const { hipId } = req.params;
  const { finalCall, notes, deviceId } = req.body as { finalCall: string; notes?: string; deviceId?: string };
  if (!finalCall) {
    res.status(400).json({ error: "Falta finalCall." });
    return;
  }
  const decision = await db.userDecision.upsert({
    where: { userId_hipId: { userId: req.user!.id, hipId } },
    create: { userId: req.user!.id, organizationId: req.user!.organizationId, hipId, finalCall, notes, deviceId, decidedAt: new Date() },
    update: { finalCall, notes, deviceId, decidedAt: new Date(), deletedAt: null },
  });
  res.json(decision);
});

router.delete("/me/decisions/:hipId", requireUser, async (req, res) => {
  const { hipId } = req.params;
  await db.userDecision.updateMany({
    where: { userId: req.user!.id, hipId },
    data: { deletedAt: new Date() },
  });
  res.json({ ok: true });
});

router.get("/me/observations", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const observations = await db.hipObservation.findMany({
    where: { userId: req.user!.id, ...(since ? { updatedAt: { gt: since } } : {}) },
    orderBy: { updatedAt: "asc" },
  });
  res.json(observations);
});

router.post("/me/observations", requireUser, async (req, res) => {
  const { hipId, text, category, deviceId } = req.body as {
    hipId: string;
    text: string;
    category?: "CONFORMATION" | "MOVEMENT" | "PEDIGREE" | "GENERAL";
    deviceId?: string;
  };
  if (!hipId || !text) {
    res.status(400).json({ error: "Faltan campos requeridos: hipId, text." });
    return;
  }
  const observation = await db.hipObservation.create({
    data: { userId: req.user!.id, organizationId: req.user!.organizationId, hipId, text, category, deviceId },
  });
  res.json(observation);
});

router.delete("/me/observations/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  await db.hipObservation.updateMany({
    where: { id, userId: req.user!.id },
    data: { deletedAt: new Date() },
  });
  res.json({ ok: true });
});

// Registro/heartbeat de dispositivo — se llama al abrir la app; deja
// `lastSeenAt` al día y da de alta el dispositivo la primera vez.
router.put("/me/devices/:deviceId", requireUser, async (req, res) => {
  const { deviceId } = req.params;
  const { platform, deviceName, appVersion, pushToken } = req.body as {
    platform: string;
    deviceName?: string;
    appVersion?: string;
    pushToken?: string;
  };
  const device = await db.device.upsert({
    where: { id: deviceId },
    create: { id: deviceId, userId: req.user!.id, platform, deviceName, appVersion, pushToken, lastSeenAt: new Date() },
    update: { platform, deviceName, appVersion, pushToken, lastSeenAt: new Date() },
  });
  res.json(device);
});

// Panel simple de administración del caballo referente (reemplaza a
// ReferenceHorseAdminView.swift, que hoy escribe esto por dispositivo).
// Scopeado a la organización del usuario autenticado — cada organización
// define su propio patrón (ver comentario en ReferenceHorse, schema.prisma).
router.get("/reference-horse", requireUser, async (req, res) => {
  res.json(await getReferenceHorse(req.user!.organizationId));
});

router.put("/reference-horse", requireUser, async (req, res) => {
  const { photoUrls, gaitVideoUrl } = req.body as { photoUrls: string[]; gaitVideoUrl?: string | null };
  if (!Array.isArray(photoUrls)) {
    res.status(400).json({ error: "photoUrls debe ser un array de URLs." });
    return;
  }
  await setReferenceHorse(req.user!.organizationId, { photoUrls, gaitVideoUrl: gaitVideoUrl ?? null });
  res.json({ ok: true });
});

// Feed de "novedades" — ventas nuevas detectadas automáticamente (ver
// saleDiscoveryService.ts) y arranques de sincronización. Global (no
// scopeado por organización, igual que Sale — ver comentario en
// SaleAlert, schema.prisma). Mismo patrón de sincronización delta que
// /me/decisions y /me/observations: la app pide "qué hay nuevo desde tal
// momento" en vez de bajar todo cada vez.
router.get("/alerts", async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const alerts = await db.saleAlert.findMany({
    where: since ? { createdAt: { gt: since } } : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { sale: { select: { house: true, name: true, catalogAccess: true, announcementUrl: true } } },
  });
  res.json(alerts);
});

// Alta de una venta (a mano, una vez por edición de venta, o para
// completar el ID real de catálogo de una venta que el descubrimiento
// automático dejó en PENDING_ID — ver comentario en Sale.catalogAccess,
// schema.prisma). El upsert por [house, externalSaleId] hace que cargar el
// ID real de una venta detectada automáticamente sea tan simple como volver
// a hacer este mismo POST con el externalSaleId correcto: como el nombre
// puede no coincidir exactamente con el que se guardó al descubrirla, esto
// crea una fila NUEVA en vez de "arreglar" la vieja — conviene desactivar
// la vieja (isActive=false) a mano una vez confirmado el ID correcto.
router.post("/sales", async (req, res) => {
  const { house, name, externalSaleId, scheduleYear, scheduleSlug } = req.body as {
    house: "FASIG_TIPTON" | "KEENELAND" | "OBS";
    name: string;
    externalSaleId: string;
    scheduleYear?: number;
    scheduleSlug?: string;
  };
  if (!house || !name || !externalSaleId) {
    res.status(400).json({ error: "Faltan campos requeridos: house, name, externalSaleId." });
    return;
  }
  const sale = await db.sale.upsert({
    where: { house_externalSaleId: { house, externalSaleId } },
    create: { house, name, externalSaleId, scheduleYear, scheduleSlug },
    update: { name, scheduleYear, scheduleSlug, isActive: true },
  });
  res.json(sale);
});
