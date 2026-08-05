import { Sale } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { clientFor } from "./saleHouses/registry";
import { pollIntervalMinutes, shouldCheckNow } from "./saleHouses/pollingPolicy";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { analyzeHip, MissingReferenceHorseError, NoPhotosError } from "./analysis/anthropicClient";
import { overallScore, classify } from "./analysis/conformationScores";
import { getReferenceHorse } from "./referenceHorse";
import { CatalogMediaItem, CatalogNotYetPublishedError } from "./types";

function startOfCalendarDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Paso 1 de cada ciclo: sincroniza el catálogo completo de una venta
 * contra la casa de ventas correspondiente (solo si ya toca según
 * pollingPolicy — ver processSale) y guarda/actualiza cada Hip: datos de
 * catálogo, media, resultado de venta oficial (precio/comprador/RNA) y
 * fecha de sesión resuelta automáticamente.
 */
export async function syncCatalog(sale: Sale): Promise<void> {
  const client = clientFor(sale.house);
  const hips = await client.fetchCatalog(sale.externalSaleId);
  const sessionDates = await client.resolveSessionDates(sale.externalSaleId, hips, {
    scheduleYear: sale.scheduleYear,
    scheduleSlug: sale.scheduleSlug,
  });

  for (const hip of hips) {
    const sessionDate = sessionDates.get(hip.hipNumber) ?? null;
    await db.hip.upsert({
      where: { saleId_hipNumber: { saleId: sale.id, hipNumber: hip.hipNumber } },
      create: {
        saleId: sale.id,
        hipNumber: hip.hipNumber,
        horseName: hip.horseName,
        sex: hip.sex,
        consignor: hip.consignor,
        sire: hip.sire,
        dam: hip.dam,
        damSire: hip.damSire,
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
        sessionDate,
        mediaJson: hip.media as unknown as object,
        saleResultJson: (hip.saleResult ?? null) as unknown as object,
        lastCatalogSyncAt: new Date(),
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
  // resuelto (PENDING_ID, ej. Fasig-Tipton) o sin ningún método de acceso
  // conocido (UNAVAILABLE, ej. OBS) NO se intentan sincronizar — pegarle a
  // la API de la casa de ventas con un ID inventado no es un método de
  // acceso autorizado, y además fallaría en cada ciclo sin nunca poder
  // actualizar lastCatalogCheckAt, generando reintentos infinitos cada 5
  // minutos. Estas ventas quedan visibles (createdAt/discoveredAt,
  // announcementUrl) pero inertes hasta que alguien complete el ID real vía
  // POST /sales — ver comentario en Sale.catalogAccess, schema.prisma.
  if (sale.catalogAccess !== "FULL") return;

  const now = new Date();
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
      } else {
        console.error(`[scheduler] Error sincronizando catálogo de ${sale.name}:`, err);
      }
      await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
      return;
    }
    await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
  }

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
      if (!withinLeadWindow) continue;
      await analyzeAndRankSession(sale.id, organization.id, sessionDate, budget);
    }
  }
}

export { pollIntervalMinutes };
