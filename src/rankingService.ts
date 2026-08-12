import { Sale } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { clientFor } from "./saleHouses/registry";
import { pollIntervalMinutes, shouldCheckNow } from "./saleHouses/pollingPolicy";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { analyzeHip, MissingReferenceHorseError, NoPhotosError } from "./analysis/anthropicClient";
import { overallScore, classify } from "./analysis/conformationScores";
import { getReferenceHorse } from "./referenceHorse";
import { CatalogMediaItem, CatalogNotYetPublishedError, NormalizedHip } from "./types";
import { resolveSaleHistoryForHip } from "./saleHistoryService";

function startOfCalendarDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Pedido explícito del usuario: 2 horas después de terminada la venta del
// día, el Ranking del Día de esa jornada se borra solo. Esta versión no
// modela la hora exacta de cierre de una sesión (ver comentario en
// pollingPolicy.ts) — "terminada la jornada" se toma como el final del día
// calendario de esa sesión (medianoche), igual criterio que ya usa el
// resto de este archivo (dayStart/dayEnd). El margen de 2h se suma después.
const RANKING_RETENTION_HOURS_AFTER_SESSION = 2;

/** Momento a partir del cual el Ranking del Día de una jornada se considera vencido (fin de esa jornada + margen) y debe dejar de regenerarse / borrarse. */
function sessionExpiresAt(sessionDate: Date): Date {
  const dayEnd = new Date(startOfCalendarDay(sessionDate).getTime() + 24 * 60 * 60 * 1000);
  return new Date(dayEnd.getTime() + RANKING_RETENTION_HOURS_AFTER_SESSION * 60 * 60 * 1000);
}

export interface UpsertSummary {
  created: number;
  updated: number;
}

/**
 * Guarda/actualiza en Postgres un lote de NormalizedHip ya resuelto —
 * mismo camino sin importar de dónde vinieron los Hips: de una API en vivo
 * (syncCatalog, más abajo) o de un CSV cargado a mano (ver
 * saleHouses/manualCatalogImport.ts, camino MANUAL_CSV). A partir de este
 * punto no hay ninguna diferencia entre ambos orígenes: mismo upsert, mismo
 * cruce de Historial de Ventas, mismo hash de media para detectar cambios
 * en el próximo análisis.
 *
 * Campos de segunda fuente (breeder/foalYear/color, ver NormalizedHip en
 * types.ts) se pasan tal cual: si vienen `undefined` (la fuente no los
 * trae), Prisma los omite del create/update en vez de sobreescribir con
 * null — así un dato bueno cargado antes por otra fuente nunca se pierde.
 */
export async function upsertNormalizedHips(saleId: string, hips: NormalizedHip[], sessionDates: Map<string, Date>): Promise<UpsertSummary> {
  const existingHipNumbers = new Set(
    (await db.hip.findMany({ where: { saleId }, select: { hipNumber: true } })).map((h) => h.hipNumber)
  );
  let created = 0;
  let updated = 0;

  for (const hip of hips) {
    const sessionDate = sessionDates.get(hip.hipNumber) ?? null;
    const savedHip = await db.hip.upsert({
      where: { saleId_hipNumber: { saleId, hipNumber: hip.hipNumber } },
      create: {
        saleId,
        hipNumber: hip.hipNumber,
        horseName: hip.horseName,
        sex: hip.sex,
        consignor: hip.consignor,
        sire: hip.sire,
        dam: hip.dam,
        damSire: hip.damSire,
        breeder: hip.breeder,
        foalYear: hip.foalYear,
        color: hip.color,
        sessionDate,
        mediaJson: hip.media as unknown as object,
        saleResultJson: (hip.saleResult ?? null) as unknown as object,
        lastCatalogSyncAt: new Date(),
      },
      update: {
        horseName: hip.horseName,
        sex: hip.sex,
        consignor: hip.consignor,
        sire: hip.sire,
        dam: hip.dam,
        damSire: hip.damSire,
        breeder: hip.breeder,
        foalYear: hip.foalYear,
        color: hip.color,
        sessionDate,
        mediaJson: hip.media as unknown as object,
        saleResultJson: (hip.saleResult ?? null) as unknown as object,
        lastCatalogSyncAt: new Date(),
      },
    });
    if (existingHipNumbers.has(hip.hipNumber)) updated += 1;
    else created += 1;

    // Historial de Ventas (ver saleHistoryService.ts): cruce interno
    // contra el resto del catálogo que ya tenemos importado, solo la
    // primera vez que este Hip queda con historial sin resolver — un Hip
    // que ya tiene alguna entrada (aunque sea "sin confirmar") no se
    // vuelve a cruzar en cada sync, para no repetir el mismo trabajo en
    // cada ciclo del scheduler. Envuelto en try/catch a propósito: un
    // fallo acá nunca debe tirar abajo la sincronización del resto del
    // catálogo de esta venta.
    if (savedHip.sire && savedHip.dam) {
      try {
        const existingHistoryCount = await db.horseSaleHistory.count({ where: { hipId: savedHip.id } });
        if (existingHistoryCount === 0) {
          await resolveSaleHistoryForHip(savedHip.id);
        }
      } catch (err) {
        console.error(`[sale-history] Error resolviendo historial para Hip ${savedHip.hipNumber}:`, err);
      }
    }
  }

  return { created, updated };
}

/**
 * Paso 1 de cada ciclo: sincroniza el catálogo completo de una venta
 * contra la casa de ventas correspondiente (solo si ya toca según
 * pollingPolicy — ver processSale) y guarda/actualiza cada Hip vía
 * upsertNormalizedHips: datos de catálogo, media, resultado de venta
 * oficial (precio/comprador/RNA) y fecha de sesión resuelta automáticamente.
 * Solo aplica a ventas catalogAccess FULL — ver manualCatalogImport.ts para
 * el camino equivalente de ventas MANUAL_CSV.
 */
export async function syncCatalog(sale: Sale): Promise<void> {
  const client = clientFor(sale.house);
  const hips = await client.fetchCatalog(sale.externalSaleId);
  const sessionDates = await client.resolveSessionDates(sale.externalSaleId, hips, {
    scheduleYear: sale.scheduleYear,
    scheduleSlug: sale.scheduleSlug,
  });

  // "NEW CATALOG DETECTED" (a pedido, 2026-08-12): se compara la cantidad
  // de Hips ANTES de este sync — si esta venta no tenía ninguno todavía y
  // ahora la casa de ventas sí trae datos, es la primera vez que su
  // catálogo aparece disponible. Se mide antes del upsert a propósito,
  // para no perder el "0 -> N" una vez que upsertNormalizedHips ya haya
  // guardado los nuevos Hips.
  const hipCountBefore = await db.hip.count({ where: { saleId: sale.id } });

  await upsertNormalizedHips(sale.id, hips, sessionDates);

  if (hipCountBefore === 0 && hips.length > 0) {
    await db.saleAlert.create({
      data: {
        saleId: sale.id,
        kind: "CATALOG_NOW_AVAILABLE",
        message: `El catálogo de "${sale.name}" ya está disponible: ${hips.length} entradas detectadas y descargadas.`,
      },
    });
  }

  // Refina Sale.startDate con la fecha REAL de sesión más próxima, ahora
  // que el catálogo ya la resolvió por Hip — más precisa que la fecha
  // aproximada que traía el anuncio público (o que un startDate viejo, si
  // la casa de ventas corrió la fecha). Si todavía no hay ninguna
  // sessionDate resuelta (catálogo publicado pero sin fechas todavía),
  // no se toca lo que ya había — nunca se borra una fecha buena por una
  // desconocida.
  const earliestSessionDate = [...sessionDates.values()].sort((a, b) => a.getTime() - b.getTime())[0];
  if (earliestSessionDate && earliestSessionDate.getTime() !== sale.startDate?.getTime()) {
    await db.sale.update({ where: { id: sale.id }, data: { startDate: earliestSessionDate } });
  }
}

/** La próxima jornada sin terminar de una venta (o null si no hay ninguna resuelta). */
async function nextSessionDate(saleId: string): Promise<Date | null> {
  const startOfToday = startOfCalendarDay(new Date());
  const hip = await db.hip.findFirst({
    where: { saleId, sessionDate: { gte: startOfToday } },
    orderBy: { sessionDate: "asc" },
  });
  return hip?.sessionDate ?? null;
}

/**
 * Presupuesto compartido de análisis dentro de UN ciclo del scheduler
 * (todas las ventas juntas) — protección de costo/estabilidad: si un bug
 * puntual hiciera que muchos Hips parecieran "cambiados" al mismo tiempo
 * (ej. una casa de ventas reordena su JSON), esto evita un gasto
 * descontrolado de la API de Anthropic en un solo ciclo. Los Hips que no
 * llegan a analizarse simplemente se reintentan en el próximo ciclo — no
 * se pierden, solo se espacian.
 */
export interface AnalysisBudget {
  remaining: number;
}

/**
 * Analiza (o reanaliza) con IA todos los Hips de una jornada que lo
 * necesiten — porque nunca se analizaron, o porque apareció una foto o
 * video nuevo desde el último análisis — y deja el ranking de esa jornada
 * actualizado. Se llama tanto para la generación anticipada (12h antes)
 * como para la actualización incremental cuando cambia algo antes de la
 * subasta.
 */
export async function analyzeAndRankSession(saleId: string, organizationId: string, sessionDate: Date, budget: AnalysisBudget): Promise<void> {
  const dayStart = startOfCalendarDay(sessionDate);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const hips = await db.hip.findMany({
    where: { saleId, sessionDate: { gte: dayStart, lt: dayEnd } },
  });
  if (hips.length === 0) return;

  // Puntero al análisis vigente de cada Hip PARA ESTA organización — bajo
  // multi-tenant, dos organizaciones pueden estar en versiones distintas
  // del mismo Hip (referentes distintos, o una todavía no lo analizó).
  const pointers = await db.currentHipAnalysis.findMany({
    where: { organizationId, hipId: { in: hips.map((h) => h.id) } },
    include: { analysisResult: true },
  });
  const pointerByHipId = new Map(pointers.map((p) => [p.hipId, p]));

  const reference = await getReferenceHorse(organizationId);
  let anyChange = false;

  for (const hip of hips) {
    const media = (hip.mediaJson as unknown as CatalogMediaItem[]) ?? [];
    const currentHash = mediaFingerprint(media);
    const pointer = pointerByHipId.get(hip.id);
    const needsAnalysis = !pointer || pointer.analysisResult.mediaHash !== currentHash;
    if (!needsAnalysis) continue;

    if (budget.remaining <= 0) {
      console.warn(`[ranking] Presupuesto de análisis agotado para este ciclo — Hip ${hip.hipNumber} queda pendiente para el próximo.`);
      continue;
    }

    const triggerReason = pointer ? "media_changed" : "initial";

    try {
      const outcome = await analyzeHip({
        hipNumber: hip.hipNumber,
        horseName: hip.horseName ?? undefined,
        media,
        reference,
      });
      budget.remaining -= 1;
      const score = overallScore(outcome.scores);
      const classification = classify(score);

      // Nunca se sobrescribe: se agrega una fila nueva de historial y
      // recién después se actualiza (o crea) el puntero CurrentHipAnalysis
      // de este Hip+organización — así una evaluación pasada nunca se
      // pierde, aunque el Hip se vuelva a analizar más adelante (ver
      // ARCHITECTURE.md sección 1a). Ambas escrituras van en UNA
      // transacción: si el proceso se corta a mitad de camino (ej. Railway
      // reinicia el contenedor), no puede quedar un AnalysisResult nuevo
      // con el puntero todavía apuntando al viejo (mostraría un puntaje
      // desactualizado sin que nada lo detecte).
      const previousVersionCount = await db.analysisResult.count({ where: { hipId: hip.id, organizationId } });
      await db.$transaction(async (tx) => {
        const created = await tx.analysisResult.create({
          data: {
            hipId: hip.id,
            organizationId,
            version: previousVersionCount + 1,
            triggerReason,
            mediaHash: currentHash,
            conformationScoresJson: outcome.scores as unknown as object,
            overallScore: score,
            classification,
            gaitFrameCount: outcome.gaitFrameCount,
            gaitVideoDurationSec: outcome.gaitVideoDurationSec,
            model: config.anthropicModel,
          },
        });
        await tx.currentHipAnalysis.upsert({
          where: { hipId_organizationId: { hipId: hip.id, organizationId } },
          create: { hipId: hip.id, organizationId, analysisResultId: created.id },
          update: { analysisResultId: created.id },
        });
      });
      anyChange = true;
    } catch (err) {
      // Un Hip puntual sin fotos suficientes, o sin caballo referente
      // configurado, no debe tirar abajo el resto de la jornada — se
      // deja afuera del ranking (sin AnalysisResult) y se sigue con el
      // resto. Se vuelve a intentar solo en el próximo ciclo.
      if (err instanceof MissingReferenceHorseError) {
        console.error(`[ranking] Organización ${organizationId}: falta configurar el caballo referente — no se puede analizar nada todavía.`);
        return;
      }
      if (err instanceof NoPhotosError) {
        console.warn(`[ranking] Hip ${hip.hipNumber}: ${err.message}`);
        continue;
      }
      console.error(`[ranking] Error analizando Hip ${hip.hipNumber}:`, err);
    }
  }

  if (!anyChange) {
    const existing = await db.rankingSnapshot.findUnique({
      where: { organizationId_saleId_sessionDate: { organizationId, saleId, sessionDate: dayStart } },
    });
    if (existing) return; // ya está al día, no hace falta recalcular
  }

  await rebuildRankingSnapshot(saleId, organizationId, dayStart, hips.length, anyChange ? "media_changed" : "initial");
}

/**
 * Análisis de UN Hip puntual "a demanda" — disparado por un dispositivo
 * que abre la pestaña Comparación de ese Hip (a diferencia de
 * analyzeAndRankSession, que corre sola por el scheduler para toda una
 * jornada). Reutiliza EXACTAMENTE el mismo camino de análisis + guardado
 * (analyzeHip + AnalysisResult + CurrentHipAnalysis) — Tarea 1,
 * reproducibilidad del análisis RM (2026-08-10): "mismo Hip + mismos
 * archivos + mismo método = mismo resultado, sin importar el dispositivo".
 *
 * Control de concurrencia: si dos dispositivos piden analizar el mismo
 * Hip al mismo tiempo, un advisory lock de Postgres (con alcance a esta
 * transacción, se libera solo al terminar) serializa ambos pedidos. El
 * segundo, al conseguir el lock, ve que el primero ya dejó un
 * AnalysisResult con el mismo mediaHash actual y devuelve ESE registro en
 * vez de volver a llamarle a la IA — nunca se generan dos análisis
 * distintos para el mismo Hip+organización al mismo tiempo.
 */
export async function analyzeHipOnDemand(
  hip: { id: string; hipNumber: string; horseName: string | null; mediaJson: unknown },
  organizationId: string,
  deviceId?: string
): Promise<{ analysis: Record<string, unknown>; reused: boolean }> {
  const media = (hip.mediaJson as unknown as CatalogMediaItem[]) ?? [];
  const currentHash = mediaFingerprint(media);
  const lockKey = `${hip.id}:${organizationId}`;

  return db.$transaction(
    async (tx) => {
      // hashtext() da un int4 determinístico a partir del string — se
      // castea a bigint porque pg_advisory_xact_lock solo tiene overload
      // de bigint (o de dos int4 separados), no de un único int4.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", lockKey);

      const pointer = await tx.currentHipAnalysis.findUnique({
        where: { hipId_organizationId: { hipId: hip.id, organizationId } },
        include: { analysisResult: true },
      });
      if (pointer && pointer.analysisResult.mediaHash === currentHash) {
        // Ya hay un análisis vigente para EXACTAMENTE esta misma media —
        // no se vuelve a llamar a la IA (evita resultados distintos entre
        // ejecuciones para el mismo Hip, y evita gastar cuota de la API
        // sin necesidad).
        return { analysis: pointer.analysisResult, reused: true };
      }

      const reference = await getReferenceHorse(organizationId);
      const outcome = await analyzeHip({
        hipNumber: hip.hipNumber,
        horseName: hip.horseName ?? undefined,
        media,
        reference,
      });
      const score = overallScore(outcome.scores);
      const classification = classify(score);
      const previousVersionCount = await tx.analysisResult.count({ where: { hipId: hip.id, organizationId } });

      const created = await tx.analysisResult.create({
        data: {
          hipId: hip.id,
          organizationId,
          version: previousVersionCount + 1,
          triggerReason: pointer ? "media_changed" : "initial",
          mediaHash: currentHash,
          conformationScoresJson: outcome.scores as unknown as object,
          overallScore: score,
          classification,
          gaitFrameCount: outcome.gaitFrameCount,
          gaitVideoDurationSec: outcome.gaitVideoDurationSec,
          model: config.anthropicModel,
          deviceId,
        },
      });
      await tx.currentHipAnalysis.upsert({
        where: { hipId_organizationId: { hipId: hip.id, organizationId } },
        create: { hipId: hip.id, organizationId, analysisResultId: created.id },
        update: { analysisResultId: created.id },
      });
      return { analysis: created, reused: false };
    },
    // El análisis (extracción de fotogramas + llamada a la IA) puede tardar
    // bastante más que el timeout default de una transacción de Prisma
    // (5s) — se extiende para que la transacción no se corte a mitad de
    // camino en un Hip con video largo.
    { timeout: 120_000, maxWait: 120_000 }
  );
}

async function rebuildRankingSnapshot(saleId: string, organizationId: string, dayStart: Date, totalHipsToday: number, triggerReason: string): Promise<void> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const hips = await db.hip.findMany({
    where: { saleId, sessionDate: { gte: dayStart, lt: dayEnd } },
    select: { id: true, hipNumber: true, horseName: true },
  });

  const pointers = await db.currentHipAnalysis.findMany({
    where: { organizationId, hipId: { in: hips.map((h) => h.id) } },
    include: { analysisResult: true },
  });
  const analysisByHipId = new Map(pointers.map((p) => [p.hipId, p.analysisResult]));

  const ranked = hips
    .map((hip) => ({ hip, analysis: analysisByHipId.get(hip.id) }))
    .filter((entry): entry is { hip: (typeof hips)[number]; analysis: NonNullable<typeof entry.analysis> } => !!entry.analysis)
    .sort((a, b) => b.analysis.overallScore - a.analysis.overallScore)
    .slice(0, config.topRankingSize);

  const entries = ranked.map((entry, index) => ({
    rank: index + 1,
    hipNumber: entry.hip.hipNumber,
    horseName: entry.hip.horseName,
    overallScore: entry.analysis.overallScore,
    classification: entry.analysis.classification,
  }));

  await db.$transaction([
    db.rankingSnapshot.upsert({
      where: { organizationId_saleId_sessionDate: { organizationId, saleId, sessionDate: dayStart } },
      create: { organizationId, saleId, sessionDate: dayStart, entriesJson: entries as unknown as object, totalHipsToday },
      update: { entriesJson: entries as unknown as object, totalHipsToday, updatedAt: new Date() },
    }),
    // Historial: una fila nueva en cada recálculo, nunca se sobrescribe —
    // deja lista la base para mostrar más adelante "cómo cambió el top 20
    // a lo largo del día" (ver ARCHITECTURE.md sección 1b).
    db.rankingSnapshotVersion.create({
      data: { organizationId, saleId, sessionDate: dayStart, entriesJson: entries as unknown as object, totalHipsToday, triggerReason },
    }),
  ]);
}

// Ventana antes de (o después de empezada) la fecha oficial de una venta
// dentro de la cual un catálogo que sigue devolviendo "sin datos" deja de
// tratarse como "todavía no publicado, es normal" y pasa a marcarse para
// revisión manual (a pedido, 2026-08-12: no confundir catálogo
// legítimamente no publicado con un método primario roto/desactualizado —
// ej. un ID de catálogo equivocado). Con 3 días de margen: una venta
// anunciada con semanas de anticipación no genera ruido, pero si a 3 días
// (o menos, o ya empezada) de la fecha oficial la API en vivo sigue sin
// traer nada, es una señal real de que el mecanismo de descubrimiento
// puede tener un problema y no simplemente "hay que esperar más".
const CATALOG_CHECK_WARNING_DAYS = 3;
// No se re-alerta en cada ciclo del scheduler (cada 5 min) mientras siga
// sin resolverse — alcanza con una vez por día para que quede visible en
// /api/v1/alerts sin inundar el feed de novedades con el mismo aviso.
const INCONCLUSIVE_ALERT_COOLDOWN_HOURS = 24;

async function flagInconclusiveIfCloseToSale(sale: Sale, now: Date): Promise<void> {
  if (!sale.startDate) return;
  const warningWindowStart = sale.startDate.getTime() - CATALOG_CHECK_WARNING_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() < warningWindowStart) return;

  const recentAlert = await db.saleAlert.findFirst({
    where: {
      saleId: sale.id,
      kind: "CATALOG_CHECK_INCONCLUSIVE",
      createdAt: { gte: new Date(now.getTime() - INCONCLUSIVE_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) },
    },
  });
  if (recentAlert) return;

  await db.saleAlert.create({
    data: {
      saleId: sale.id,
      kind: "CATALOG_CHECK_INCONCLUSIVE",
      message: `"${sale.name}" empieza el ${sale.startDate.toISOString().slice(0, 10)} y el método primario de chequeo (API de catálogo en vivo, ID "${sale.externalSaleId}") todavía no devuelve datos. Puede ser que la casa de ventas realmente no lo haya publicado todavía, o que el ID/endpoint usado ya no sea el correcto — conviene revisar a mano.`,
    },
  });
}

/**
 * Un ciclo completo del scheduler para UNA venta: decide si toca volver a
 * chequear el catálogo (según pollingPolicy, UNA sola vez — el catálogo es
 * global, no se duplica por organización), sincroniza si corresponde, y
 * después dispara/actualiza el análisis de cada organización activa para
 * cualquier jornada que ya esté dentro de la ventana de generación
 * anticipada (RANKING_LEAD_HOURS antes del inicio) o que tenga Hips con
 * media nueva desde el último análisis de esa organización.
 */
export async function processSale(sale: Sale, organizations: { id: string }[], budget: AnalysisBudget): Promise<void> {
  // Ventas detectadas automáticamente pero sin ID de catálogo real
  // resuelto (PENDING_ID, ej. Fasig-Tipton sin completar) o sin NINGÚN
  // camino de acceso conocido, ni siquiera manual (UNAVAILABLE) NO tienen
  // nada que hacer todavía — ver comentario en Sale.catalogAccess,
  // schema.prisma. FULL y MANUAL_CSV sí pueden llegar a tener Hips
  // cargados (FULL los trae solo más abajo; MANUAL_CSV los recibe vía
  // POST /sales/:saleId/catalog/import, ver manualCatalogImport.ts) — en
  // cualquiera de los dos casos, la ventana de análisis/ranking de más
  // abajo corre igual, sin diferenciar de dónde vino el catálogo.
  if (sale.catalogAccess === "PENDING_ID" || sale.catalogAccess === "UNAVAILABLE") return;

  const now = new Date();

  if (sale.catalogAccess === "FULL") {
    const upcoming = await nextSessionDate(sale.id);

    if (shouldCheckNow(now, sale.lastCatalogCheckAt, upcoming)) {
      // lastCatalogCheckAt se actualiza pase lo que pase (éxito o error) —
      // antes solo se actualizaba adentro de syncCatalog() al terminar bien,
      // así que una venta que fallara SIEMPRE (ej. Keeneland todavía sin
      // publicar el catálogo de un sale, devolviendo 200 con body vacío)
      // nunca llegaba a esa línea y quedaba con lastCatalogCheckAt en null
      // para siempre — shouldCheckNow() la volvía a intentar en CADA ciclo
      // del scheduler en vez de respetar el intervalo normal de
      // pollingPolicy, golpeando la API de la casa de ventas mucho más
      // seguido de lo necesario para un catálogo que legítimamente no
      // existe todavía.
      try {
        await syncCatalog(sale);
      } catch (err) {
        // Catálogo todavía no publicado (200 con body vacío) es un estado
        // ESPERADO para ventas anunciadas con anticipación — se loguea
        // aparte, sin nivel "error", para no ensuciar los logs con algo que
        // no hay que arreglar, solo esperar a que la casa de ventas publique.
        // Cualquier otro fallo (red, HTTP no-2xx, JSON roto de verdad) sigue
        // yendo como error real.
        if (err instanceof CatalogNotYetPublishedError) {
          console.log(`[scheduler] ${sale.name}: ${err.message} Se reintenta según el intervalo normal.`);
          await flagInconclusiveIfCloseToSale(sale, now);
        } else {
          console.error(`[scheduler] Error sincronizando catálogo de ${sale.name}:`, err);
        }
        await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
        return;
      }
      await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
    }
  }
  // MANUAL_CSV: no hay ninguna API contra la que chequear — el catálogo se
  // actualiza solo cuando alguien sube un CSV nuevo (POST
  // /sales/:saleId/catalog/import ya deja lastCatalogCheckAt al día en ese
  // momento). El resto de esta función no distingue el origen del catálogo.

  const leadMs = config.rankingLeadHours * 60 * 60 * 1000;
  const sessionDates = await db.hip.findMany({
    where: { saleId: sale.id, sessionDate: { not: null } },
    distinct: ["sessionDate"],
    select: { sessionDate: true },
  });

  // Ventas × organizaciones activas: a esta escala (una sola organización
  // hoy) un doble loop simple alcanza. El día que haya muchas
  // organizaciones, conviene filtrar acá primero "qué organizaciones
  // siguen esta venta" en vez de recorrerlas todas — ver ARCHITECTURE.md.
  for (const organization of organizations) {
    for (const { sessionDate } of sessionDates) {
      if (!sessionDate) continue;
      const withinLeadWindow = now.getTime() >= sessionDate.getTime() - leadMs;
      // Jornada ya terminada (+ margen de 2h): no volver a generar su
      // Ranking del Día — si ya se borró (ver cleanupExpiredRankingSnapshots)
      // debe quedar borrado, no resucitar en el próximo tick.
      const expired = now.getTime() >= sessionExpiresAt(sessionDate).getTime();
      if (!withinLeadWindow || expired) continue;
      await analyzeAndRankSession(sale.id, organization.id, sessionDate, budget);
    }
  }
}

/**
 * Borra el Ranking del Día "vigente" (RankingSnapshot, lo único que lee la
 * app — ver GET /ranking) de cualquier jornada cuya ventana de retención ya
 * venció (2h después de terminada esa jornada). NO toca
 * RankingSnapshotVersion: ese historial de cómo evolucionó el ranking a lo
 * largo del día queda intacto para auditoría / features futuras (ver
 * ARCHITECTURE.md sección 1b) — solo se borra la lista que la app muestra
 * hoy. Se llama una vez por ciclo del scheduler (cada 5 min), sobre todas
 * las ventas/organizaciones a la vez.
 */
export async function cleanupExpiredRankingSnapshots(): Promise<number> {
  const cutoff = new Date(Date.now() - (24 + RANKING_RETENTION_HOURS_AFTER_SESSION) * 60 * 60 * 1000);
  const { count } = await db.rankingSnapshot.deleteMany({ where: { sessionDate: { lte: cutoff } } });
  return count;
}

export { pollIntervalMinutes };
