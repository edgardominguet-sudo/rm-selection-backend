import { randomUUID } from "crypto";
import { Router } from "express";
import { db } from "../db";
import { config } from "../config";
import { setReferenceHorse, getReferenceHorse } from "../referenceHorse";
import { requireUser } from "./auth";
import { resolveSaleHistoryForHip, readSaleHistory } from "../saleHistoryService";
import { analyzeHipOnDemand, syncCatalog } from "../rankingService";
import { runNightlyMediaSweep } from "../mediaSweepService";
import { CatalogNotYetPublishedError } from "../types";
import { MissingReferenceHorseError, NoPhotosError } from "../analysis/anthropicClient";
import {
  importManualCatalog,
  EmptyManualCatalogError,
  MissingHipNumberColumnError,
  SaleNotFoundError,
} from "../saleHouses/manualCatalogImport";
import {
  buildStorageKey,
  createUploadUrl,
  resolveReadUrl,
  deleteObject,
  ObjectStorageNotConfiguredError,
} from "../storage/r2Client";


export const router = Router();

/**
 * Resuelve un Hip a partir de los mismos identificadores que ya conoce la
 * app (house + externalSaleId + hipNumber) — mismo criterio que /ranking,
 * para no requerir que la app se entere de ningún id interno de la base.
 * Devuelve `null` (sin responder nada) si la venta o el Hip no existen,
 * dejando que el caller decida el 404.
 */
async function findHipByIdentity(house: string, externalSaleId: string, hipNumber: string) {
  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: house as never, externalSaleId } } });
  if (!sale) return null;
  return db.hip.findUnique({ where: { saleId_hipNumber: { saleId: sale.id, hipNumber } } });
}

// Ventas dadas de alta (para que la app arme el selector inicial sin
// tener que hardcodear IDs de venta en el cliente), ordenadas
// cronológicamente por fecha real de venta — juntas, sin importar la casa
// — de la más próxima a la más lejana. Las que todavía no tienen ninguna
// fecha resuelta (caso raro: alta manual sin startDate) quedan al final
// en vez de romper el orden.
router.get("/sales", async (_req, res) => {
  const sales = await db.sale.findMany({
    where: { isActive: true },
    select: {
      id: true,
      house: true,
      name: true,
      externalSaleId: true,
      startDate: true,
      catalogAccess: true,
      // Visibilidad operativa mínima ("¿hace cuánto se actualizó esto?",
      // "¿ya tiene algún Hip cargado?") sin que la app tenga que inferirlo
      // de otro lado — campos nuevos, aditivos: no rompen ningún cliente
      // existente que decodifique esta respuesta ignorando claves que no
      // conoce (ver SaleAlertSaleInfo.swift, mismo patrón).
      lastCatalogCheckAt: true,
      announcementUrl: true,
      _count: { select: { hips: true } },
    },
  });
  const withHipCount = sales.map(({ _count, ...rest }) => ({ ...rest, hipCount: _count.hips }));
  withHipCount.sort((a, b) => {
    if (a.startDate && b.startDate) return a.startDate.getTime() - b.startDate.getTime();
    if (a.startDate) return -1;
    if (b.startDate) return 1;
    return 0;
  });
  res.json(withHipCount);
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

// Catálogo completo de una venta, ya guardado en la base de RM Selection —
// pensado para ventas cuyo catálogo llegó por un camino que el DISPOSITIVO
// no puede repetir solo (ej. MANUAL_CSV: un CSV que se subió una vez desde
// afuera de la app) o para cualquier venta FULL cuando se prefiere leer lo
// que el servidor ya sincronizó en vez de pegarle de nuevo a la casa de
// ventas desde el propio dispositivo. Identificada por house+externalSaleId
// (mismo criterio que /ranking y /hips/sale-history) para que la app nunca
// necesite enterarse de ningún id interno de la base.
//
// 2026-08-13: agregado porque se detectó que "Fasig-Tipton — New York Bred
// Yearlings" ya tenía 317 Hips reales importados en el servidor (vía CSV
// manual) pero la app no tenía ninguna forma de leerlos — su SaleOption
// usaba EmptyHipDataService() porque el único camino que existía hasta
// ahora era pegarle en vivo a la API de la casa de ventas con un ID
// numérico real, que Fasig-Tipton no expone públicamente para esta venta.
router.get("/sales/hips", requireUser, async (req, res) => {
  const house = req.query.house as string | undefined;
  const externalSaleId = req.query.externalSaleId as string | undefined;

  if (!house || !externalSaleId) {
    res.status(400).json({ error: "Faltan parámetros: house, externalSaleId." });
    return;
  }

  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: house as never, externalSaleId } } });
  if (!sale) {
    res.json({ saleName: null, catalogAccess: null, hipCount: 0, hips: [] });
    return;
  }

  const hips = await db.hip.findMany({
    where: { saleId: sale.id },
    orderBy: { hipNumber: "asc" },
    select: {
      hipNumber: true,
      horseName: true,
      sex: true,
      consignor: true,
      barn: true,
      sire: true,
      dam: true,
      damSire: true,
      breeder: true,
      foalYear: true,
      color: true,
      sessionDate: true,
      mediaJson: true,
      saleResultJson: true,
    },
  });

  res.json({
    saleName: sale.name,
    catalogAccess: sale.catalogAccess,
    hipCount: hips.length,
    hips,
  });
});

// Calendario de Ventas (SaleDay) de una venta: Fecha → Libro → rango de
// Hip, ya resuelto solo por el backend (ver syncSaleDays en
// rankingService.ts / keenelandHipGrouping.ts) — nunca cargado a mano.
// Mismo criterio de identidad que el resto (house+externalSaleId).
// Devuelve lista vacía (no error) cuando la venta todavía no tiene
// calendario resuelto — la app debe tratarlo como "calendario no
// disponible todavía", no como una falla.
router.get("/sales/days", requireUser, async (req, res) => {
  const house = req.query.house as string | undefined;
  const externalSaleId = req.query.externalSaleId as string | undefined;

  if (!house || !externalSaleId) {
    res.status(400).json({ error: "Faltan parámetros: house, externalSaleId." });
    return;
  }

  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: house as never, externalSaleId } } });
  if (!sale) {
    res.json({ saleName: null, days: [] });
    return;
  }

  const days = await db.saleDay.findMany({
    where: { saleId: sale.id },
    orderBy: { date: "asc" },
    select: {
      date: true,
      book: true,
      sessionNumber: true,
      startTimeLabel: true,
      hipRangeStart: true,
      hipRangeEnd: true,
      headCount: true,
    },
  });

  res.json({ saleName: sale.name, days });
});

// Historial de Ventas de un Hip: quién lo crió (si se pudo determinar) y
// cero, una o varias apariciones anteriores de este mismo caballo en otra
// venta — ver plan "RM Selection — Módulo de Historial de Ventas" y
// saleHistoryService.ts. Catálogo global (como Sale/Hip), pero igual exige
// usuario autenticado (mismo criterio que /ranking y /sales/:saleId/hips/:hipNumber)
// en vez de dejarla totalmente abierta.
//
// La primera vez que se consulta un Hip sin ningún historial resuelto
// todavía, esta ruta dispara una resolución best-effort antes de
// responder (cruce interno contra el resto del catálogo ya importado) —
// así la tarjeta "Historial de Ventas" de la app no necesita un paso
// manual para el caso más común. Consultas siguientes solo leen lo ya
// resuelto, sin volver a cruzar nada — para eso está POST .../refresh.
router.get("/hips/sale-history", requireUser, async (req, res) => {
  const house = req.query.house as string | undefined;
  const externalSaleId = req.query.externalSaleId as string | undefined;
  const hipNumber = req.query.hipNumber as string | undefined;

  if (!house || !externalSaleId || !hipNumber) {
    res.status(400).json({ error: "Faltan parámetros: house, externalSaleId, hipNumber." });
    return;
  }

  const hip = await findHipByIdentity(house, externalSaleId, hipNumber);
  if (!hip) {
    res.status(404).json({ error: "No se encontró ese Hip." });
    return;
  }

  const existingCount = await db.horseSaleHistory.count({ where: { hipId: hip.id } });
  if (existingCount === 0) {
    try {
      await resolveSaleHistoryForHip(hip.id);
    } catch (err) {
      // Best-effort: si el cruce interno falla por lo que sea, se sigue
      // respondiendo con lo que haya (probablemente "sin ventas
      // anteriores") en vez de devolver un error — el usuario siempre
      // puede reintentar con el botón "Actualizar historial de ventas".
      console.error("[sale-history] Error resolviendo historial:", err);
    }
  }

  res.json(await readSaleHistory(hip.id));
});

// Botón manual "Actualizar historial de ventas": fuerza una resolución
// nueva ahora mismo, en vez de esperar a que se dispare sola. Mismo
// criterio de identificación que el GET de arriba.
router.post("/hips/sale-history/refresh", requireUser, async (req, res) => {
  const { house, externalSaleId, hipNumber } = req.body as {
    house?: string;
    externalSaleId?: string;
    hipNumber?: string;
  };

  if (!house || !externalSaleId || !hipNumber) {
    res.status(400).json({ error: "Faltan campos: house, externalSaleId, hipNumber." });
    return;
  }

  const hip = await findHipByIdentity(house, externalSaleId, hipNumber);
  if (!hip) {
    res.status(404).json({ error: "No se encontró ese Hip." });
    return;
  }

  await resolveSaleHistoryForHip(hip.id);
  res.json(await readSaleHistory(hip.id));
});

// Resuelve la identidad que ya conoce la app (house + externalSaleId +
// hipNumber, ver SaleOption.swift) al id interno (cuid) que usa el
// servidor para TODO lo que un usuario sincroniza sobre un Hip —
// decisiones, observaciones, medios, reportes veterinarios, puntaje
// manual (ver MARK más abajo). Necesario porque la identidad de la app
// nunca coincidía con el id de la base (a diferencia de /ranking o /sales,
// que resuelven todo del lado del servidor sin exponer ningún id interno)
// — sin esto, la app no tiene ningún hipId válido para mandar en esas
// rutas. Se cachea del lado de la app (ver HipIdentityResolver.swift) para
// no resolver esto en cada sincronización.
router.get("/hips/resolve", requireUser, async (req, res) => {
  const house = req.query.house as string | undefined;
  const externalSaleId = req.query.externalSaleId as string | undefined;
  const hipNumber = req.query.hipNumber as string | undefined;

  if (!house || !externalSaleId || !hipNumber) {
    res.status(400).json({ error: "Faltan parámetros: house, externalSaleId, hipNumber." });
    return;
  }

  const hip = await findHipByIdentity(house, externalSaleId, hipNumber);
  if (!hip) {
    res.status(404).json({ error: "No se encontró ese Hip." });
    return;
  }

  res.json({ hipId: hip.id });
});

// MARK: - Análisis RM oficial de un Hip — Tarea 1 (reproducibilidad,
// 2026-08-10). El análisis con IA ya NO se corre en cada dispositivo por
// separado (eso es lo que hacía que el mismo Hip diera puntajes distintos
// en el iPad y en el iPhone): el backend es la única fuente del resultado.
// Reusa el mismo AnalysisResult/CurrentHipAnalysis que ya alimenta el
// Ranking del Día (ver rankingService.analyzeHipOnDemand).

// Lee el análisis vigente (si existe) de la organización del usuario para
// este Hip — sin disparar ningún análisis nuevo.
router.get("/hips/:hipId/analysis", requireUser, async (req, res) => {
  const { hipId } = req.params;
  const organizationId = req.user!.organizationId;
  const pointer = await db.currentHipAnalysis.findUnique({
    where: { hipId_organizationId: { hipId, organizationId } },
    include: { analysisResult: true },
  });
  res.json({ analysis: pointer?.analysisResult ?? null });
});

// Dispara (o reutiliza) el análisis oficial de este Hip. Si ya existe un
// AnalysisResult vigente con el mismo mediaHash que la media actual del
// Hip, lo devuelve tal cual (reused:true) sin volver a llamar a la IA. Si
// no, lo genera ahora, lo guarda como fuente oficial, y lo devuelve
// (reused:false). Concurrencia resuelta con un advisory lock de Postgres
// (ver analyzeHipOnDemand) — dos dispositivos pidiendo el mismo Hip al
// mismo tiempo nunca generan dos análisis distintos.
router.post("/hips/:hipId/analysis", requireUser, async (req, res) => {
  const { hipId } = req.params;
  const { deviceId } = req.body as { deviceId?: string };
  const organizationId = req.user!.organizationId;

  const hip = await db.hip.findUnique({ where: { id: hipId } });
  if (!hip) {
    res.status(404).json({ error: "Hip no encontrado." });
    return;
  }

  try {
    const result = await analyzeHipOnDemand(hip, organizationId, deviceId);
    res.json(result);
  } catch (err) {
    if (err instanceof MissingReferenceHorseError) {
      res.status(409).json({ error: "Falta configurar el caballo referente para esta organización." });
      return;
    }
    if (err instanceof NoPhotosError) {
      res.status(422).json({ error: err.message });
      return;
    }
    console.error(`[analysis] Hip ${hipId}:`, err);
    res.status(500).json({ error: "No se pudo completar el análisis." });
  }
});

// MARK: - Decisiones y observaciones del usuario (sincronización entre
// dispositivos — ver ARCHITECTURE.md sección 3). Estas rutas ya quedan
// disponibles aunque la app de iOS todavía no las llame: cuando se haga el
// trabajo del lado de iOS para romper decisiones/observaciones en
// entidades sincronizables, el backend no va a necesitar otro deploy.

// Identidad mínima del Hip (casa + id de venta + número) que se suma a
// cada fila de decisión/observación en el delta — sin esto, un dispositivo
// que TODAVÍA no descargó/abrió ese Hip localmente (ej. recién logueado)
// no tendría ninguna forma de saber a qué Hip corresponde el hipId interno
// que devuelve la base, y la decisión/observación bajada quedaría
// huérfana sin poder mostrarse. Con esto, el dispositivo puede crear el
// Hip localmente (con lo mínimo: número + identidad de venta) si todavía
// no lo tenía, en vez de descartar el registro.
const hipIdentitySelect = { select: { hipNumber: true, sale: { select: { house: true, externalSaleId: true } } } };

function withHipIdentity<T extends { hip: { hipNumber: string; sale: { house: string; externalSaleId: string } } }>(row: T) {
  const { hip, ...rest } = row;
  return { ...rest, hipIdentity: { hipNumber: hip.hipNumber, house: hip.sale.house, externalSaleId: hip.sale.externalSaleId } };
}

// Todo lo que cambió desde `since` (o todo si no se manda) — patrón de
// sincronización delta: el dispositivo pide "qué cambió" en vez de bajar
// todo cada vez.
router.get("/me/decisions", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const decisions = await db.userDecision.findMany({
    where: { userId: req.user!.id, ...(since ? { updatedAt: { gt: since } } : {}) },
    orderBy: { updatedAt: "asc" },
    include: { hip: hipIdentitySelect },
  });
  res.json(decisions.map(withHipIdentity));
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

// Anotaciones a mano alzada sobre el Pedigree (lápiz vino tinto + borrador,
// 2026-08-13 — sistema simplificado). Mismo patrón exacto que /me/decisions:
// una fila por (userId, hipId), upsert, tombstone para borrados. El cliente
// manda el PKDrawing completo serializado en base64 en cada guardado (no
// hace falta granularidad de trazo por trazo).
router.get("/me/pedigree-annotations", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const rows = await db.pedigreeAnnotation.findMany({
    where: { userId: req.user!.id, ...(since ? { updatedAt: { gt: since } } : {}) },
    orderBy: { updatedAt: "asc" },
    include: { hip: hipIdentitySelect },
  });
  res.json(rows.map(withHipIdentity));
});

router.put("/me/pedigree-annotations/:hipId", requireUser, async (req, res) => {
  const { hipId } = req.params;
  const { drawingData, deviceId } = req.body as { drawingData?: string | null; deviceId?: string };
  const annotation = await db.pedigreeAnnotation.upsert({
    where: { userId_hipId: { userId: req.user!.id, hipId } },
    create: { userId: req.user!.id, organizationId: req.user!.organizationId, hipId, drawingData, deviceId },
    update: { drawingData, deviceId, deletedAt: null },
  });
  res.json(annotation);
});

router.delete("/me/pedigree-annotations/:hipId", requireUser, async (req, res) => {
  const { hipId } = req.params;
  await db.pedigreeAnnotation.updateMany({
    where: { userId: req.user!.id, hipId },
    data: { deletedAt: new Date(), drawingData: null },
  });
  res.json({ ok: true });
});

router.get("/me/observations", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const observations = await db.hipObservation.findMany({
    where: { userId: req.user!.id, ...(since ? { updatedAt: { gt: since } } : {}) },
    orderBy: { updatedAt: "asc" },
    include: { hip: hipIdentitySelect },
  });
  res.json(observations.map(withHipIdentity));
});

// `id` opcional: el cliente puede mandar su propio UUID (así ya se genera
// localmente en iOS, ver HipObservation.id) para que ESTE mismo id quede
// como clave primaria en el servidor — necesario para que un reintento de
// sincronización (ej. la respuesta del primer POST se perdió por la red,
// pero el insert sí se hizo) sea un upsert idempotente en vez de crear una
// fila duplicada. Sin `id`, se genera uno server-side (cuid), igual que
// antes — mantiene compatibilidad con cualquier otro caller.
router.post("/me/observations", requireUser, async (req, res) => {
  const { id, hipId, text, category, deviceId } = req.body as {
    id?: string;
    hipId: string;
    text: string;
    category?: "CONFORMATION" | "MOVEMENT" | "PEDIGREE" | "GENERAL";
    deviceId?: string;
  };
  if (!hipId || !text) {
    res.status(400).json({ error: "Faltan campos requeridos: hipId, text." });
    return;
  }
  const data = { userId: req.user!.id, organizationId: req.user!.organizationId, hipId, text, category, deviceId };
  const observation = id
    ? await db.hipObservation.upsert({
        where: { id },
        create: { id, ...data },
        // Solo re-sincroniza (no pisa un borrado con datos viejos si el
        // tombstone ya se guardó) — deletedAt: null solo si no estaba borrada.
        update: { ...data },
      })
    : await db.hipObservation.create({ data });
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

// MARK: - Medios del usuario (fotos/videos propios, reportes veterinarios)
// — sincronización multidispositivo, 2026-08-08. Antes de esto, un archivo
// capturado en un dispositivo NUNCA aparecía en los demás: vivía solo en el
// Documents local de ESE dispositivo. Subida en dos fases contra
// Cloudflare R2 (ver storage/r2Client.ts): el servidor nunca ve el archivo
// en sí, solo genera URLs firmadas.
//
// Paso 1: el dispositivo pide una URL de subida.
//
// `id` opcional: igual que en POST /me/observations, el cliente puede
// mandar su propio id (en iOS, el mismo UUID que ya tiene MediaItem.id)
// para que el mismo archivo tenga el mismo id en el cliente y en el
// servidor — necesario para poder deduplicar en el `pull` (si no, un
// dispositivo no podría saber si una fila que bajó es "la misma foto que
// yo subí" o una nueva) y para que reintentar una subida interrumpida sea
// un upsert idempotente en vez de crear un registro duplicado.
router.post("/me/media", requireUser, async (req, res) => {
  const { id: clientId, hipId, kind, contentType, byteSize, deviceId } = req.body as {
    id?: string;
    hipId?: string;
    kind?: "PHOTO" | "VIDEO" | "VET_REPORT" | "PEDIGREE_CHART";
    contentType?: string;
    byteSize?: number;
    deviceId?: string;
  };
  if (!hipId || !kind) {
    res.status(400).json({ error: "Faltan campos requeridos: hipId, kind." });
    return;
  }
  // Se genera/usa el id ANTES del insert para poder calcular storageKey en
  // la misma escritura — evita una segunda ronda a la base solo para
  // corregir la clave.
  const id = clientId ?? randomUUID();
  const storageKey = buildStorageKey({ organizationId: req.user!.organizationId, hipId, kind, mediaAssetId: id, contentType });
  const data = { userId: req.user!.id, organizationId: req.user!.organizationId, hipId, deviceId, kind, contentType, byteSize, storageKey };
  const asset = await db.mediaAsset.upsert({
    where: { id },
    create: { id, ...data },
    // Reintento de una subida que no llegó a confirmarse: vuelve a
    // PENDING_UPLOAD (no toca uploadStatus directamente porque el default
    // de creación ya lo deja ahí, y un update explícito lo dejaría igual)
    // y limpia un tombstone viejo si lo hubiera.
    update: { ...data, deletedAt: null },
  });
  try {
    const uploadUrl = createUploadUrl(storageKey);
    res.json({ id: asset.id, storageKey, uploadUrl, expiresInSeconds: 900 });
  } catch (err) {
    if (err instanceof ObjectStorageNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// Paso 2: el dispositivo confirma que el archivo ya se subió a la URL firmada.
router.put("/me/media/:id/confirm", requireUser, async (req, res) => {
  const { id } = req.params;
  const asset = await db.mediaAsset.findFirst({ where: { id, userId: req.user!.id } });
  if (!asset) {
    res.status(404).json({ error: "MediaAsset no encontrado." });
    return;
  }
  const updated = await db.mediaAsset.update({ where: { id }, data: { uploadStatus: "PROCESSED" } });
  res.json(updated);
});

// Delta — mismo patrón que /me/decisions y /me/observations. Solo se
// devuelven los assets ya PROCESSED (los PENDING_UPLOAD todavía no tienen
// nada real para leer en otro dispositivo) más los tombstones, para que un
// dispositivo que canceló una subida a mitad de camino se entere del borrado.
router.get("/me/media", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const hipId = req.query.hipId as string | undefined;
  const assets = await db.mediaAsset.findMany({
    where: {
      userId: req.user!.id,
      ...(hipId ? { hipId } : {}),
      ...(since ? { updatedAt: { gt: since } } : {}),
      OR: [{ uploadStatus: "PROCESSED" }, { deletedAt: { not: null } }],
    },
    orderBy: { updatedAt: "asc" },
    include: { hip: hipIdentitySelect },
  });
  const withReadUrl = assets.map((a) => {
    const withIdentity = withHipIdentity(a);
    return {
      ...withIdentity,
      readUrl: a.deletedAt || a.uploadStatus !== "PROCESSED" ? null : resolveReadUrlSafe(a.storageKey),
    };
  });
  res.json(withReadUrl);
});

function resolveReadUrlSafe(storageKey: string): string | null {
  try {
    return resolveReadUrl(storageKey);
  } catch {
    return null;
  }
}

router.delete("/me/media/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  const asset = await db.mediaAsset.findFirst({ where: { id, userId: req.user!.id } });
  if (!asset) {
    res.status(404).json({ error: "MediaAsset no encontrado." });
    return;
  }
  await db.mediaAsset.update({ where: { id }, data: { deletedAt: new Date() } });
  // Best-effort: si el borrado físico en R2 falla (bucket no configurado
  // en este momento, etc.), el tombstone ya quedó guardado — no se pierde
  // la sincronización del borrado por un problema del lado del storage.
  deleteObject(asset.storageKey).catch((err) => console.error(`[media] No se pudo borrar el objeto ${asset.storageKey} de R2:`, err));
  res.json({ ok: true });
});

// MARK: - Reportes veterinarios — mismo criterio de sincronización que
// UserDecision/HipObservation. El archivo en sí es un MediaAsset (kind
// VET_REPORT); este registro es la metadata + notas.
router.get("/me/vet-reports", requireUser, async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const reports = await db.vetReport.findMany({
    where: { userId: req.user!.id, ...(since ? { updatedAt: { gt: since } } : {}) },
    orderBy: { updatedAt: "asc" },
    include: { hip: hipIdentitySelect },
  });
  res.json(reports.map(withHipIdentity));
});

router.post("/me/vet-reports", requireUser, async (req, res) => {
  const { hipId, mediaAssetId, notes, deviceId } = req.body as {
    hipId?: string;
    mediaAssetId?: string;
    notes?: string;
    deviceId?: string;
  };
  if (!hipId) {
    res.status(400).json({ error: "Falta hipId." });
    return;
  }
  const report = await db.vetReport.create({
    data: { userId: req.user!.id, organizationId: req.user!.organizationId, hipId, mediaAssetId, notes, deviceId },
  });
  res.json(report);
});

router.put("/me/vet-reports/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  const { mediaAssetId, notes } = req.body as { mediaAssetId?: string; notes?: string };
  const existing = await db.vetReport.findFirst({ where: { id, userId: req.user!.id } });
  if (!existing) {
    res.status(404).json({ error: "VetReport no encontrado." });
    return;
  }
  const updated = await db.vetReport.update({ where: { id }, data: { mediaAssetId, notes, deletedAt: null } });
  res.json(updated);
});

router.delete("/me/vet-reports/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  await db.vetReport.updateMany({ where: { id, userId: req.user!.id }, data: { deletedAt: new Date() } });
  res.json({ ok: true });
});

// MARK: - Puntaje manual — a pedido (2026-08-08, sincronización
// multidispositivo): un usuario puede cargar/corregir a mano el puntaje de
// un Hip desde cualquier dispositivo, y ese puntaje tiene que verse en los
// demás igual que uno de IA. Se agrega como una versión más del mismo
// historial (AnalysisResult, source=MANUAL) — mismo mecanismo de
// version/CurrentHipAnalysis que ya usa el análisis automático (ver
// rankingService.ts), así el resto de la app (historial, "análisis
// vigente") no necesita ninguna rama de código nueva para mostrarlo.
router.put("/me/hips/:hipId/manual-score", requireUser, async (req, res) => {
  const { hipId } = req.params;
  const { conformationScores, overallScore, classification, summary, deviceId } = req.body as {
    conformationScores?: object;
    overallScore?: number;
    classification?: string;
    summary?: string;
    deviceId?: string;
  };
  if (!conformationScores || typeof overallScore !== "number" || !classification) {
    res.status(400).json({ error: "Faltan campos requeridos: conformationScores, overallScore, classification." });
    return;
  }
  const hip = await db.hip.findUnique({ where: { id: hipId } });
  if (!hip) {
    res.status(404).json({ error: "Hip no encontrado." });
    return;
  }
  const organizationId = req.user!.organizationId;
  const previousVersionCount = await db.analysisResult.count({ where: { hipId, organizationId } });
  const created = await db.$transaction(async (tx) => {
    const result = await tx.analysisResult.create({
      data: {
        hipId,
        organizationId,
        version: previousVersionCount + 1,
        triggerReason: "manual",
        source: "MANUAL",
        enteredByUserId: req.user!.id,
        deviceId,
        conformationScoresJson: conformationScores as object,
        overallScore,
        classification,
        summary,
        model: "manual",
      },
    });
    await tx.currentHipAnalysis.upsert({
      where: { hipId_organizationId: { hipId, organizationId } },
      create: { hipId, organizationId, analysisResultId: result.id },
      update: { analysisResultId: result.id },
    });
    return result;
  });
  res.json(created);
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
  const { photoUrls, gaitVideoUrl, lateralPhotoUrl, frontalPhotoUrl, posteriorPhotoUrl } = req.body as {
    photoUrls?: string[];
    gaitVideoUrl?: string | null;
    lateralPhotoUrl?: string | null;
    frontalPhotoUrl?: string | null;
    posteriorPhotoUrl?: string | null;
  };
  if (photoUrls !== undefined && !Array.isArray(photoUrls)) {
    res.status(400).json({ error: "photoUrls debe ser un array de URLs." });
    return;
  }
  await setReferenceHorse(req.user!.organizationId, {
    photoUrls,
    gaitVideoUrl,
    lateralPhotoUrl,
    frontalPhotoUrl,
    posteriorPhotoUrl,
  });
  res.json({ ok: true });
});

// Almacenamiento propio de fotos del caballo referente (Postgres, sin R2)
// — vía alternativa mientras el bucket de R2 no esté configurado (Tarea 1,
// 2026-08-10). El cliente (iOS) sube cada foto acá, recibe una URL propia
// del backend, y esa URL es la que después manda en PUT /reference-horse
// como parte de photoUrls. Ver ReferenceHorsePhoto en schema.prisma.
router.post("/reference-horse/photos", requireUser, async (req, res) => {
  const { dataBase64, mimeType } = req.body as { dataBase64?: string; mimeType?: string };
  if (!dataBase64 || typeof dataBase64 !== "string") {
    res.status(400).json({ error: "dataBase64 es requerido (imagen codificada en base64, sin el prefijo data:...)." });
    return;
  }
  const photo = await db.referenceHorsePhoto.create({
    data: {
      organizationId: req.user!.organizationId,
      mimeType: mimeType && typeof mimeType === "string" ? mimeType : "image/jpeg",
      dataBase64,
    },
  });
  res.json({ id: photo.id, url: `${config.publicBaseUrl}/api/v1/reference-horse/photos/${photo.id}` });
});

// NOTA: el GET que sirve el archivo real vive en index.ts, montado ANTES
// del middleware requireApiKey — tiene que quedar sin autenticación para
// que analyzeHip (fetch() del lado del servidor, sin headers propios)
// pueda leer las fotos. Si se define acá también, este router nunca lo
// alcanza a ejecutar porque requireApiKey ya lo habría cortado antes.

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
  const { house, name, externalSaleId, scheduleYear, scheduleSlug, startDate } = req.body as {
    house: "FASIG_TIPTON" | "KEENELAND" | "OBS";
    name: string;
    externalSaleId: string;
    scheduleYear?: number;
    scheduleSlug?: string;
    // Opcional: fecha real de la venta, "YYYY-MM-DD" o ISO completo, si se
    // conoce al darla de alta a mano — alimenta el orden cronológico de
    // GET /sales. Si no se manda, queda null hasta que syncCatalog la
    // resuelva sola a partir de los Hips (ver rankingService.ts).
    startDate?: string;
  };
  if (!house || !name || !externalSaleId) {
    res.status(400).json({ error: "Faltan campos requeridos: house, name, externalSaleId." });
    return;
  }
  const parsedStartDate = startDate ? new Date(startDate) : undefined;
  const sale = await db.sale.upsert({
    where: { house_externalSaleId: { house, externalSaleId } },
    create: { house, name, externalSaleId, scheduleYear, scheduleSlug, startDate: parsedStartDate },
    update: { name, scheduleYear, scheduleSlug, isActive: true, ...(parsedStartDate ? { startDate: parsedStartDate } : {}) },
  });
  res.json(sale);
});

// Actualiza el ID real de catálogo de una venta YA EXISTENTE, por su id
// interno — pensado para el caso "esta venta quedó con
// catalogAccess=PENDING_ID o MANUAL_CSV porque no se conocía su ID numérico
// real (ver saleHouses/discovery/fasigTiptonDiscovery.ts), y ahora sí se
// consiguió". A diferencia de POST /sales de arriba (que upsert-ea por
// [house, externalSaleId] y por eso crearía una fila NUEVA si el
// externalSaleId cambia), esto actualiza la MISMA fila — conserva todos los
// Hips, Decisiones, Favoritos y anotaciones ya cargados contra este
// sale.id. Pasa a catalogAccess=FULL y resetea lastCatalogCheckAt a null
// para que el próximo tick del scheduler (cada 5 min) dispare un
// syncCatalog inmediato en vez de esperar el intervalo normal de
// pollingPolicy. Cambio chico y reversible: para revertir, basta volver a
// hacer este mismo POST con el externalSaleId sintético anterior y
// catalogAccess a mano en la base.
// DIAGNÓSTICO TEMPORAL (2026-08-17) — para probar el resolver headless de
// Fasig-Tipton contra páginas reales sin tocar ninguna venta en la base.
router.post("/sales/:id/resolve-external-id", async (req, res) => {
  const { id } = req.params;
  const { externalSaleId } = req.body as { externalSaleId?: string };
  if (!externalSaleId) {
    res.status(400).json({ error: "Falta externalSaleId." });
    return;
  }
  const sale = await db.sale.findUnique({ where: { id } });
  if (!sale) {
    res.status(404).json({ error: "Venta no encontrada." });
    return;
  }
  const updated = await db.sale.update({
    where: { id },
    data: { externalSaleId, catalogAccess: "FULL", lastCatalogCheckAt: null },
  });
  res.json({
    ok: true,
    sale: updated,
    note: "catalogAccess ahora FULL. El scheduler (cada 5 min) va a sincronizar catálogo, Media y resultados automáticamente en el próximo ciclo.",
  });
});

// Fuerza AHORA un chequeo de catálogo contra la API en vivo de la casa de
// ventas, saltando el intervalo normal de pollingPolicy (ver
// saleHouses/pollingPolicy.ts) — pensado para el caso "sé que la casa de
// ventas acaba de publicar el catálogo, no quiero esperar hasta el próximo
// chequeo automático" (a más de 30 días de la venta, ese intervalo es de
// hasta 24h). Es el MISMO camino que usa el scheduler (syncCatalog), sin
// cambiar la lógica de detección/import — solo evita la espera. Idempotente:
// puede llamarse las veces que haga falta sin duplicar Hips (mismo upsert
// por [saleId, hipNumber] de siempre). Solo aplica a ventas catalogAccess
// FULL — MANUAL_CSV no tiene ninguna API contra la que chequear (ver
// comentario en processSale, rankingService.ts), y PENDING_ID/UNAVAILABLE
// no tienen ID real todavía.
async function handleCatalogResync(sale: NonNullable<Awaited<ReturnType<typeof db.sale.findUnique>>>, res: import("express").Response, opts: { forcePdfProbe?: boolean } = {}) {
  if (sale.catalogAccess !== "FULL") {
    res.status(400).json({
      error: `Esta venta tiene catalogAccess=${sale.catalogAccess}, no FULL — no hay ninguna API en vivo contra la que forzar un chequeo.`,
    });
    return;
  }

  const hipCountBefore = await db.hip.count({ where: { saleId: sale.id } });
  const now = new Date();
  try {
    await syncCatalog(sale, opts);
    await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
    const hipCountAfter = await db.hip.count({ where: { saleId: sale.id } });
    res.json({
      ok: true,
      saleName: sale.name,
      hipCountBefore,
      hipCountAfter,
      newHips: hipCountAfter - hipCountBefore,
    });
  } catch (err) {
    await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
    if (err instanceof CatalogNotYetPublishedError) {
      res.json({ ok: false, saleName: sale.name, published: false, message: err.message });
      return;
    }
    console.error(`[catalog-resync] Error sincronizando catálogo de ${sale.name}:`, err);
    res.status(500).json({ error: "Error interno sincronizando el catálogo. Ver logs del servidor." });
  }
}

router.post("/sales/:saleId/catalog/resync", async (req, res) => {
  const sale = await db.sale.findUnique({ where: { id: req.params.saleId } });
  if (!sale) {
    res.status(404).json({ error: "Venta no encontrada." });
    return;
  }
  const forcePdfProbe = req.body?.forcePdfProbe === true || req.query.forcePdfProbe === "true";
  await handleCatalogResync(sale, res, { forcePdfProbe });
});

// Variante GET, navegable directo desde un browser (sin body/POST) — mismo
// efecto que la de arriba, identificando la venta por house+externalSaleId
// en vez del id interno (los mismos datos públicos que ya expone GET
// /sales). Pensada para poder forzar el chequeo a mano sin herramientas
// adicionales, ej. GET /api/v1/sales/resync?house=KEENELAND&externalSaleId=12.
router.get("/sales/resync", async (req, res) => {
  const house = req.query.house as string | undefined;
  const externalSaleId = req.query.externalSaleId as string | undefined;
  if (!house || !externalSaleId) {
    res.status(400).json({ error: "Faltan parámetros: house, externalSaleId." });
    return;
  }
  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: house as never, externalSaleId } } });
  if (!sale) {
    res.status(404).json({ error: "Venta no encontrada." });
    return;
  }
  const forcePdfProbe = req.query.forcePdfProbe === "true";
  await handleCatalogResync(sale, res, { forcePdfProbe });
});

// Mismo forzado de arriba, pero identificando la venta por house +
// externalSaleId (los mismos datos públicos que ya expone GET /sales) en
// vez del id interno — evita tener que consultar el id interno primero
// solo para poder forzar un resync.
router.post("/sales/resync", async (req, res) => {
  const { house, externalSaleId } = req.body as { house?: string; externalSaleId?: string };
  if (!house || !externalSaleId) {
    res.status(400).json({ error: "Faltan campos requeridos: house, externalSaleId." });
    return;
  }
  const sale = await db.sale.findUnique({ where: { house_externalSaleId: { house: house as never, externalSaleId } } });
  if (!sale) {
    res.status(404).json({ error: "Venta no encontrada." });
    return;
  }
  const forcePdfProbe = (req.body as { forcePdfProbe?: boolean })?.forcePdfProbe === true;
  await handleCatalogResync(sale, res, { forcePdfProbe });
});

// MARK: - Import manual de catálogo (SaleCatalogAccess.MANUAL_CSV, hoy OBS —
// ver comentario en schema.prisma y saleHouses/manualCatalogImport.ts). El
// mismo camino sirve para CUALQUIER venta, no solo MANUAL_CSV: una FULL
// también puede recibir un import puntual (ej. corregir un dato, adelantar
// fotos antes de que la API en vivo las publique) sin que eso cambie cómo
// sigue sincronizándose el resto de su catálogo.
//
// Se manda el CSV como texto plano dentro de JSON (no multipart) — un
// catálogo de unos pocos cientos de Hips entra de sobra en el límite de 2mb
// que ya tiene configurado express.json() (ver index.ts), y evita sumar una
// dependencia nueva (multer) solo para este caso.
router.post("/sales/:saleId/catalog/import", requireUser, async (req, res) => {
  const { saleId } = req.params;
  const { csv, fileName } = req.body as { csv?: string; fileName?: string };

  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: 'Falta el campo "csv" (texto plano del archivo) en el body.' });
    return;
  }

  try {
    const outcome = await importManualCatalog(saleId, csv, {
      fileName,
      importedByUserId: req.user!.id,
    });
    res.json({
      ok: true,
      catalogImportId: outcome.catalogImport.id,
      rowsParsed: outcome.catalogImport.rowCount,
      hipsCreated: outcome.summary.created,
      hipsUpdated: outcome.summary.updated,
      catalogAccess: outcome.catalogAccess,
      warnings: outcome.warnings,
    });
  } catch (err) {
    if (err instanceof SaleNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof EmptyManualCatalogError || err instanceof MissingHipNumberColumnError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(`[catalog-import] Error importando catálogo de venta ${saleId}:`, err);
    res.status(500).json({ error: "Error interno importando el catálogo. Revisá el formato del CSV e intentá de nuevo." });
  }
});

// Auditoría de imports manuales de una venta — más reciente primero. Útil
// para responder "¿cuándo se cargó esto por última vez y quién lo hizo?"
// sin tener que revisar logs de Railway (mismo espíritu que SchedulerRun).
router.get("/sales/:saleId/catalog/imports", requireUser, async (req, res) => {
  const { saleId } = req.params;
  const imports = await db.catalogImport.findMany({
    where: { saleId },
    orderBy: { createdAt: "desc" },
    include: { importedByUser: { select: { displayName: true, email: true } } },
  });
  res.json(imports);
});

// MARK: - Barrido de Media (fotos/video de catálogo) — ver mediaSweepService.ts.
//
// Disparo MANUAL de diagnóstico (2026-08-15, a pedido explícito de Ramon:
// "necesitamos comprobar AHORA que el mecanismo realmente funciona, no
// esperar hasta las 3am"). Corre exactamente el mismo mecanismo que el
// cron nocturno (runNightlyMediaSweep), acotado a UNA sola venta — nunca
// se reinventa un camino aparte. Se ejecuta de forma SÍNCRONA (se espera
// la respuesta) a propósito: es una corrida de diagnóstico puntual sobre
// una sola venta, no el barrido completo de todas las ventas activas, así
// que el tiempo de respuesta es razonable y el llamador necesita ver el
// resultado real (Hips revisados, fotos/videos encontrados) en la misma
// respuesta, no adivinar consultando logs después.
router.post("/sales/:saleId/media-sweep", requireUser, async (req, res) => {
  const { saleId } = req.params;
  const sale = await db.sale.findUnique({ where: { id: saleId } });
  if (!sale) {
    res.status(404).json({ error: "Venta no encontrada." });
    return;
  }
  try {
    const summary = await runNightlyMediaSweep({ trigger: "manual", saleId });
    res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[media-sweep] Error en corrida manual para "${sale.name}":`, err);
    res.status(500).json({ error: `Error corriendo el barrido de Media para "${sale.name}": ${message}` });
  }
});

// Historial de corridas del barrido de Media (automáticas Y manuales) —
// para poder confirmar "¿corrió anoche a las 3am? ¿qué encontró?" sin
// depender de los logs de Railway (mismo espíritu que
// /sales/:saleId/catalog/imports). Más reciente primero.
router.get("/media-sweep/runs", requireUser, async (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const runs = await db.mediaSweepRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  res.json(runs);
});
