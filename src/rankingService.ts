import { Sale } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { clientFor } from "./saleHouses/registry";
import { pollIntervalMinutes, shouldCheckNow } from "./saleHouses/pollingPolicy";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { analyzeHip, MissingReferenceHorseError, NoPhotosError, ViewAnalysisDetail } from "./analysis/anthropicClient";
import { ViewName } from "./analysis/landmarks";
import { PhotoClassification } from "./analysis/prompt";
import { overallScore, classify, emptyScores, setScore, LATERAL_TRAITS, FRONTAL_TRAITS, POSTERIOR_TRAITS, METHODOLOGY_VERSION, ConformationScores } from "./analysis/conformationScores";
import { getReferenceHorse } from "./referenceHorse";
import { CatalogMediaItem, CatalogNotYetPublishedError, NormalizedHip, SaleHouseClient } from "./types";
import { resolveSaleHistoryForHip } from "./saleHistoryService";
import { recordOfficialSaleResult } from "./officialSaleResultService";
import { resolveReadUrl } from "./storage/r2Client";
import { resolveSaleDaysFromSessionDates } from "./saleHouses/sessionDateSaleDays";

/**
 * Fotos de un Hip que puede usar el motor de Análisis IA — Tarea "Análisis
 * IA" (2026-08-13, regla dura del Método RM): ÚNICA Y EXCLUSIVAMENTE las
 * que el usuario tomó desde la pantalla Análisis (IA) de ese Hip
 * (MediaAsset.kind = AI_ANALYSIS_PHOTO). Nunca `hip.mediaJson` (eso es
 * catálogo de la casa de ventas) ni ningún otro MediaAsset (Media general,
 * reporte veterinario, pedigree). Devuelve URLs de lectura firmadas,
 * resueltas recién acá (se usan una sola vez, en la misma request).
 */
async function resolveAIAnalysisMedia(hipId: string, organizationId: string): Promise<CatalogMediaItem[]> {
  const assets = await db.mediaAsset.findMany({
    where: { hipId, organizationId, kind: "AI_ANALYSIS_PHOTO", uploadStatus: "PROCESSED", deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  // `id`/`conformationView` viajan desde 2026-09-01 (independencia de
  // vistas, ver CatalogMediaItem en types.ts) — no afectan mediaFingerprint
  // (solo mira kind+url, ver mediaFingerprint.ts) ni ningún otro llamador
  // existente, y le permiten a analyzeHipOnDemand saber, foto por foto,
  // cuál pertenece a cuál tarjeta (frontal/lateral/posterior) sin depender
  // de la posición dentro del array.
  return assets.map((a) => ({ kind: "photo" as const, url: resolveReadUrl(a.storageKey), id: a.id, conformationView: a.conformationView }));
}

/**
 * Agrupa la media de Análisis IA vigente de un Hip por vista
 * (frontal/lateral/posterior), usando el tag que el dispositivo de origen
 * grabó en cada foto (`conformationView`, ver MediaAsset en schema.prisma)
 * — NO la clasificación de la IA (esa es la que valida/invalida, no la
 * que decide a qué tarjeta pertenece cada archivo, ver comentario en
 * HipDetailViewModel.swift sobre "la tarjeta es definitiva"). Fotos sin
 * `conformationView` reconocible (legado, o un valor inesperado) quedan
 * afuera de los 3 baldes — se tratan como "vista sin identificar", ver
 * `analyzeHipOnDemand` más abajo.
 */
function groupAIAnalysisMediaByView(media: CatalogMediaItem[]): Partial<Record<ViewName, CatalogMediaItem>> {
  const result: Partial<Record<ViewName, CatalogMediaItem>> = {};
  for (const item of media) {
    if (item.conformationView === "frontal" || item.conformationView === "lateral" || item.conformationView === "posterior") {
      // Si por algún motivo hay más de una foto activa con el mismo tag
      // (no debería pasar en uso normal — cada tarjeta reemplaza la suya
      // al tomar una nueva), gana la más reciente (orden `createdAt asc`
      // de resolveAIAnalysisMedia, así que la última pisa a la anterior).
      result[item.conformationView] = item;
    }
  }
  return result;
}

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
  // Se busca acá adentro (una sola vez por lote) en vez de agregar un
  // parámetro `sale: Sale` a la firma — así ninguno de los dos call sites
  // (syncCatalog acá abajo, y manualCatalogImport.ts, que solo trae un
  // `select` parcial) tiene que cambiar. Solo hace falta para la base
  // histórica permanente (ver recordOfficialSaleResult, más abajo).
  const sale = await db.sale.findUniqueOrThrow({ where: { id: saleId } });
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
        barn: hip.barn,
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
        barn: hip.barn,
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

    // Base histórica PERMANENTE de RM Selection (TAREA 1, 2026-08-13, ver
    // officialSaleResultService.ts): graba/actualiza el resultado oficial
    // de este Hip en OfficialSaleResult, independiente del ciclo de vida
    // de la fila Hip en sí — no hace nada si la casa de ventas todavía no
    // publicó ningún dato real. Envuelto en try/catch por el mismo motivo
    // que el cruce de Historial de Ventas de abajo: nunca debe tirar
    // abajo la sincronización del resto del catálogo.
    try {
      await recordOfficialSaleResult(savedHip, sale);
    } catch (err) {
      console.error(`[official-sale-result] Error registrando resultado oficial para Hip ${savedHip.hipNumber}:`, err);
    }

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
 * Resuelve y persiste el Calendario de Ventas (SaleDay) de una venta —
 * Fecha → Libro → rango de Hip, tal como lo publica la casa. Genérico por
 * casa: si el cliente de esta casa todavía no implementa
 * resolveSaleDays() (ver types.ts), no hace nada — el calendario de esa
 * venta simplemente queda vacío, nunca es un error. Envuelto en try/catch
 * a propósito: un fallo acá nunca debe tirar abajo el resto de syncCatalog.
 */
async function syncSaleDays(sale: Sale, client: SaleHouseClient): Promise<void> {
  if (!client.resolveSaleDays) {
    console.log(`[sale-days] "${sale.name}" (${sale.house}): esta casa todavía no implementa resolveSaleDays — calendario queda vacío por ahora.`);
    return;
  }
  try {
    console.log(`[sale-days] "${sale.name}": resolviendo calendario (scheduleYear=${sale.scheduleYear ?? "null"}, scheduleSlug=${sale.scheduleSlug ?? "null"})…`);
    const days = await client.resolveSaleDays(sale.externalSaleId, {
      scheduleYear: sale.scheduleYear,
      scheduleSlug: sale.scheduleSlug,
    });
    console.log(`[sale-days] "${sale.name}": ${days.length} jornada(s) resuelta(s) desde la fuente oficial.`);
    for (const day of days) {
      await db.saleDay.upsert({
        where: { saleId_date: { saleId: sale.id, date: day.date } },
        create: {
          saleId: sale.id,
          date: day.date,
          book: day.book ?? null,
          sessionNumber: day.sessionNumber ?? null,
          startTimeLabel: day.startTimeLabel ?? null,
          hipRangeStart: day.hipRangeStart ?? null,
          hipRangeEnd: day.hipRangeEnd ?? null,
          headCount: day.headCount ?? null,
          source: day.source,
        },
        update: {
          book: day.book ?? null,
          sessionNumber: day.sessionNumber ?? null,
          startTimeLabel: day.startTimeLabel ?? null,
          hipRangeStart: day.hipRangeStart ?? null,
          hipRangeEnd: day.hipRangeEnd ?? null,
          headCount: day.headCount ?? null,
          source: day.source,
        },
      });
    }
  } catch (err) {
    console.error(`[sale-days] Error resolviendo calendario de "${sale.name}":`, err);
  }
}

/**
 * Equivalente a syncSaleDays() de arriba, pero para ventas MANUAL_CSV (hoy,
 * el único camino real de catálogo de OBS — ver manualCatalogImport.ts — y
 * también el camino usado para Fasig-Tipton cuando su ID real de venta
 * todavía no se pudo resolver, ej. "New York Bred Yearlings", importada por
 * CSV el 2026-08-15). Estas ventas no tienen ningún SaleHouseClient al que
 * pedirle el calendario (no hay ID de API real contra el que consultar) —
 * pero SÍ pueden tener, Hip por Hip, una "Session Date" real ya cargada por
 * el propio CSV (ver parseManualCatalogCsv → upsertNormalizedHips →
 * Hip.sessionDate). En vez de inventar un calendario o dejarlo vacío para
 * siempre, se arma con el MISMO helper genérico que usan Fasig-Tipton/OBS
 * en su variante FULL (resolveSaleDaysFromSessionDates), pero leyendo las
 * fechas ya persistidas en la base en vez de llamar a ninguna API — nunca
 * se inventa una fecha que el CSV no trajo.
 */
async function syncSaleDaysFromStoredHips(sale: Sale): Promise<void> {
  const hips = await db.hip.findMany({
    where: { saleId: sale.id, sessionDate: { not: null } },
    select: { hipNumber: true, sessionDate: true },
  });
  if (hips.length === 0) {
    console.log(`[sale-days] "${sale.name}" (${sale.house}, MANUAL_CSV): todavía no hay ningún Hip con Session Date cargada — calendario queda vacío por ahora.`);
    return;
  }
  const sessionDates = new Map<string, Date>();
  for (const hip of hips) {
    if (hip.sessionDate) sessionDates.set(hip.hipNumber, hip.sessionDate);
  }
  const days = resolveSaleDaysFromSessionDates(sessionDates, "MANUAL_CSV_IMPORTED_SESSION_DATE");
  console.log(`[sale-days] "${sale.name}" (MANUAL_CSV): ${days.length} jornada(s) resuelta(s) desde las Session Date ya importadas.`);
  for (const day of days) {
    await db.saleDay.upsert({
      where: { saleId_date: { saleId: sale.id, date: day.date } },
      create: {
        saleId: sale.id,
        date: day.date,
        book: day.book ?? null,
        sessionNumber: day.sessionNumber ?? null,
        startTimeLabel: day.startTimeLabel ?? null,
        hipRangeStart: day.hipRangeStart ?? null,
        hipRangeEnd: day.hipRangeEnd ?? null,
        headCount: day.headCount ?? null,
        source: day.source,
      },
      update: {
        book: day.book ?? null,
        sessionNumber: day.sessionNumber ?? null,
        startTimeLabel: day.startTimeLabel ?? null,
        hipRangeStart: day.hipRangeStart ?? null,
        hipRangeEnd: day.hipRangeEnd ?? null,
        headCount: day.headCount ?? null,
        source: day.source,
      },
    });
  }
}

/**
 * Sincroniza el catálogo completo de una venta contra la casa de ventas
 * correspondiente y guarda/actualiza cada Hip vía upsertNormalizedHips:
 * datos de catálogo, media, resultado de venta oficial (precio/comprador/
 * RNA) y fecha de sesión resuelta automáticamente. Solo aplica a ventas
 * catalogAccess FULL — ver manualCatalogImport.ts para el camino
 * equivalente de ventas MANUAL_CSV.
 *
 * CORRECCIÓN 2026-08-17: hasta ahora corría automáticamente dentro de
 * processSale() en cada ciclo del scheduler (cada 5 min, con cadencia
 * variable según pollingPolicy). A pedido explícito del propietario, el
 * llamado automático se movió a syncCatalogsForActiveSales(), que corre UNA
 * sola vez al día a las 3:00 a.m. (ver scheduler.ts/runNightlySyncCycle).
 * Esta función en sí no cambió — sigue siendo el mismo camino que también
 * usan los endpoints de resync manual en api/routes.ts (handleCatalogResync),
 * que pueden seguir llamándola en cualquier momento a pedido explícito del
 * usuario (eso no es "automático en segundo plano", es una acción manual).
 */
export async function syncCatalog(sale: Sale, opts: { forcePdfProbe?: boolean } = {}): Promise<void> {
  const client = clientFor(sale.house);

  // "NEW CATALOG DETECTED" (a pedido, 2026-08-12): se compara la cantidad
  // de Hips ANTES de este sync — si esta venta no tenía ninguno todavía y
  // ahora la casa de ventas sí trae datos, es la primera vez que su
  // catálogo aparece disponible. Se mide ANTES de pedir el catálogo (no
  // solo antes del upsert) porque desde 2026-08-14 KeenelandClient también
  // usa este número para decidir si vale la pena correr el mecanismo de
  // respaldo pesado (probing de PDFs por Hip) — ver
  // keenelandPedigreePdfCatalog.ts: solo se corre la primera vez, nunca en
  // cada ciclo del scheduler.
  const hipCountBefore = await db.hip.count({ where: { saleId: sale.id } });

  const hips = await client.fetchCatalog(sale.externalSaleId, {
    name: sale.name,
    startDate: sale.startDate,
    hipCountBeforeSync: hipCountBefore,
    forcePdfProbe: opts.forcePdfProbe,
  });
  const sessionDates = await client.resolveSessionDates(sale.externalSaleId, hips, {
    scheduleYear: sale.scheduleYear,
    scheduleSlug: sale.scheduleSlug,
  });

  await upsertNormalizedHips(sale.id, hips, sessionDates);

  // Calendario de Ventas (SaleDay): resuelto en processSale(), NO acá —
  // corre en todos los ciclos del scheduler (no atado a la cadencia de
  // shouldCheckNow de esta función), así una venta con catálogo pero sin
  // calendario todavía se resuelve sola en el siguiente ciclo, sin esperar
  // el intervalo largo de re-chequeo de catálogo completo. Ver comentario
  // completo en processSale.

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
  const sortedSessionDates = [...sessionDates.values()].sort((a, b) => a.getTime() - b.getTime());
  const earliestSessionDate = sortedSessionDates[0];
  if (earliestSessionDate && earliestSessionDate.getTime() !== sale.startDate?.getTime()) {
    await db.sale.update({ where: { id: sale.id }, data: { startDate: earliestSessionDate } });
  }
  // Simétrico a lo de arriba, para Sale.endDate ("Día X de Y", selector de
  // ventas de la app) — la sessionDate MÁS TARDÍA resuelta hasta ahora.
  // Igual criterio de "nunca borrar una fecha buena por una desconocida".
  const latestSessionDate = sortedSessionDates[sortedSessionDates.length - 1];
  if (latestSessionDate && latestSessionDate.getTime() !== sale.endDate?.getTime()) {
    await db.sale.update({ where: { id: sale.id }, data: { endDate: latestSessionDate } });
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
    // Análisis IA (2026-08-13): SOLO fotos tomadas por el usuario desde la
    // pantalla Análisis (IA) de este Hip — nunca `hip.mediaJson` (catálogo).
    // Un Hip sin esas 3 fotos todavía queda afuera del Ranking del Día
    // hasta que el usuario las tome — comportamiento nuevo, a propósito
    // (ver comentario de resolveAIAnalysisMedia).
    const media = await resolveAIAnalysisMedia(hip.id, organizationId);
    const currentHash = mediaFingerprint(media);
    const pointer = pointerByHipId.get(hip.id);
    const needsAnalysis = !pointer || pointer.analysisResult.mediaHash !== currentHash;
    if (!needsAnalysis) continue;

    if (budget.remaining <= 0) {
      console.warn(`[ranking] Presupuesto de análisis agotado para este ciclo — Hip ${hip.hipNumber} queda pendiente para el próximo.`);
      continue;
    }

    // No se genera ningún puntaje sin las 3 fotos (frontal/lateral/
    // posterior) — mismo criterio que se aplica del lado de iOS antes de
    // siquiera pedir el análisis, repetido acá porque este ciclo corre
    // solo (scheduler) sin pasar por esa pantalla.
    if (media.length < 3) continue;

    const triggerReason = pointer ? "media_changed" : "initial";

    try {
      const outcome = await analyzeHip({
        hipNumber: hip.hipNumber,
        horseName: hip.horseName ?? undefined,
        organizationId,
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
            methodologyVersion: outcome.methodologyVersion,
            photoClassificationsJson: outcome.photoClassifications as unknown as object,
            // Motor de Análisis Anatómico (2026-08-14) — landmarks y
            // hallazgos crudos por vista, para poder auditar cualquier
            // análisis pasado sin volver a llamar a la IA. Ver
            // ViewAnalysisDetail en anthropicClient.ts.
            landmarksJson: outcome.detail as unknown as object,
            findingsJson: Object.fromEntries(
              Object.entries(outcome.detail).map(([view, d]) => [view, d.displayFindings])
            ) as unknown as object,
            summary: outcome.summary,
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
function summarizeMergedView(view: ViewName, detail: ViewAnalysisDetail): string {
  const label = view === "frontal" ? "Frontal" : view === "lateral" ? "Lateral" : "Posterior";
  if (!detail.available) return `${label}: sin foto válida, no evaluado.`;
  const score = detail.score?.score ?? 0;
  if (detail.displayFindings.length === 0) return `${label}: correcto (${score.toFixed(1)}).`;
  const names = detail.displayFindings.map((f) => `${f.labelEs} (${f.severity})`).join(", ");
  return `${label}: ${names} — ${score.toFixed(1)}.`;
}

const TRAITS_BY_VIEW: Record<ViewName, readonly string[]> = {
  lateral: LATERAL_TRAITS,
  frontal: FRONTAL_TRAITS,
  posterior: POSTERIOR_TRAITS,
};

const UNAVAILABLE_DETAIL: ViewAnalysisDetail = { available: false, landmarks: null, findings: [], score: null, displayFindings: [] };

export async function analyzeHipOnDemand(
  hip: { id: string; hipNumber: string; horseName: string | null },
  organizationId: string,
  deviceId?: string
): Promise<{ analysis: Record<string, unknown>; reused: boolean }> {
  // Análisis IA (2026-08-13): SOLO las fotos que el usuario tomó desde la
  // pantalla Análisis (IA) de este Hip — nunca el catálogo (hip.mediaJson)
  // ni Media general. Ver resolveAIAnalysisMedia.
  const media = await resolveAIAnalysisMedia(hip.id, organizationId);
  if (media.length === 0) {
    throw new NoPhotosError(
      "Todavía no hay ninguna foto tomada desde Análisis (IA) para este Hip."
    );
  }
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

      // INDEPENDENCIA DE VISTAS (2026-09-01, a pedido explícito de Ramon:
      // "una acción realizada sobre una foto NO debe afectar las otras...
      // prohibir reanálisis automático en cascada"). A partir de acá, algo
      // en la media cambió (el hash de arriba no coincidió) — pero eso NO
      // significa que las 3 vistas necesiten un análisis nuevo: se
      // determina, vista por vista, si la foto que la ocupa hoy es
      // EXACTAMENTE la misma (mismo MediaAsset.id) que la que produjo el
      // resultado guardado la última vez. Solo esas vistas "sucias" vuelven
      // a pasar por el motor — las demás se copian tal cual, sin volver a
      // llamar a la IA ni recalcular nada.
      const previous = pointer?.analysisResult ?? null;
      const previousSourceIds = (previous?.viewSourceAssetIdsJson as Partial<Record<ViewName, string>> | null) ?? null;
      const currentByView = groupAIAnalysisMediaByView(media);
      const viewNames: ViewName[] = ["frontal", "lateral", "posterior"];

      // Sin procedencia guardada (fila anterior a este campo, o primer
      // análisis de este Hip): ninguna vista cuenta como estable — se
      // recalculan las 3 una sola vez, igual que un análisis nuevo de
      // siempre. Con procedencia guardada, una vista es estable si y solo
      // si el id de su foto actual coincide con el id que la produjo la
      // última vez (ambos ausentes — "seguía sin foto" — también cuenta
      // como estable, ver test 1 de la especificación: borrar UNA vista no
      // debe tocar las otras dos).
      const dirtyViews = previousSourceIds
        ? viewNames.filter((view) => (currentByView[view]?.id ?? null) !== (previousSourceIds[view] ?? null))
        : [...viewNames];

      // Fotos con un conformationView no reconocible (legado, o valor
      // inesperado) nunca tienen procedencia por vista posible — siempre
      // se mandan a analizar junto con lo que esté sucio.
      const untaggedMedia = media.filter(
        (m) => m.conformationView !== "frontal" && m.conformationView !== "lateral" && m.conformationView !== "posterior"
      );
      const dirtyMedia: CatalogMediaItem[] = [
        ...dirtyViews.map((v) => currentByView[v]).filter((m): m is CatalogMediaItem => !!m),
        ...untaggedMedia,
      ];

      // Si lo único "sucio" es una vista a la que le borraron la foto (sin
      // reemplazo todavía), no hay ninguna foto nueva que mandarle a la
      // IA — ni falta, ni corresponde exigir el caballo referente para
      // simplemente vaciar esa vista.
      const fresh = dirtyMedia.length > 0
        ? await analyzeHip({
            hipNumber: hip.hipNumber,
            horseName: hip.horseName ?? undefined,
            organizationId,
            media: dirtyMedia,
            reference: await getReferenceHorse(organizationId),
          })
        : null;

      const previousDetail = (previous?.landmarksJson as unknown as Record<ViewName, ViewAnalysisDetail> | null) ?? null;
      const previousClassifications = (previous?.photoClassificationsJson as unknown as PhotoClassification[] | null) ?? [];
      const previousScores = (previous?.conformationScoresJson as unknown as ConformationScores | null) ?? null;

      const mergedDetail = {} as Record<ViewName, ViewAnalysisDetail>;
      const mergedScores = emptyScores();
      const mergedSourceIds: Partial<Record<ViewName, string>> = {};
      const summaryLines: string[] = [];

      for (const view of viewNames) {
        const isDirty = dirtyViews.includes(view);
        const freshDetailForView = fresh?.detail[view];
        if (isDirty && freshDetailForView?.available) {
          // Vista sucia con foto nueva que dio válida: resultado fresco.
          mergedDetail[view] = freshDetailForView;
          for (const key of TRAITS_BY_VIEW[view]) setScore(mergedScores, `${view}.${key}`, fresh!.scores[`${view}.${key}`] ?? 0);
          if (fresh!.viewSourceAssetIds[view]) mergedSourceIds[view] = fresh!.viewSourceAssetIds[view];
        } else if (isDirty) {
          // Vista sucia sin resultado disponible (la foto se borró, o la
          // foto nueva no dio válida para esta vista) — queda "sin foto".
          // Nunca hereda el resultado viejo: ese pertenecía a OTRA foto.
          mergedDetail[view] = UNAVAILABLE_DETAIL;
          if (currentByView[view]?.id) mergedSourceIds[view] = currentByView[view]!.id!;
        } else if (previousDetail?.[view]) {
          // Vista estable: se copia bit a bit de la fila anterior — nunca
          // se le vuelve a pedir nada a la IA.
          mergedDetail[view] = previousDetail[view];
          if (previousScores) {
            for (const key of TRAITS_BY_VIEW[view]) setScore(mergedScores, `${view}.${key}`, previousScores[`${view}.${key}`] ?? 0);
          }
          if (previousSourceIds?.[view]) mergedSourceIds[view] = previousSourceIds[view]!;
        } else {
          mergedDetail[view] = UNAVAILABLE_DETAIL;
        }
        summaryLines.push(summarizeMergedView(view, mergedDetail[view]));
      }

      // photoClassifications final: las clasificaciones frescas (de cada
      // foto que se acaba de mandar a analizar) + las clasificaciones
      // previas cuya FOTO (por assetId, no por `.view` — una foto inválida
      // puede tener `.view === "unclear"` y aun así pertenecer a una
      // vista estable, ej. una tarjeta que quedó en rojo y nadie tocó)
      // sigue siendo la misma de una vista estable.
      const stableViews = viewNames.filter((v) => !dirtyViews.includes(v));
      const stableAssetIds = new Set(stableViews.map((v) => previousSourceIds?.[v]).filter((id): id is string => !!id));
      const mergedClassifications: PhotoClassification[] = [
        ...(fresh?.photoClassifications ?? []),
        ...previousClassifications.filter((c) => c.assetId && stableAssetIds.has(c.assetId)),
      ];

      const score = overallScore(mergedScores);
      const classification = classify(score);
      const previousVersionCount = await tx.analysisResult.count({ where: { hipId: hip.id, organizationId } });

      const created = await tx.analysisResult.create({
        data: {
          hipId: hip.id,
          organizationId,
          version: previousVersionCount + 1,
          triggerReason: pointer ? "media_changed" : "initial",
          mediaHash: currentHash,
          conformationScoresJson: mergedScores as unknown as object,
          overallScore: score,
          classification,
          methodologyVersion: fresh?.methodologyVersion ?? previous?.methodologyVersion ?? METHODOLOGY_VERSION,
          photoClassificationsJson: mergedClassifications as unknown as object,
          landmarksJson: mergedDetail as unknown as object,
          findingsJson: Object.fromEntries(
            Object.entries(mergedDetail).map(([view, d]) => [view, d.displayFindings])
          ) as unknown as object,
          summary: summaryLines.join(" "),
          model: config.anthropicModel,
          deviceId,
          viewSourceAssetIdsJson: mergedSourceIds as unknown as object,
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
 * PASO DIARIO ÚNICO (2026-08-17, a pedido explícito del propietario):
 * "toda actualización de precios de ventas, videos, fotos y descarga de
 * catálogos de nuevas ventas disponibles" debe correr SOLO a las 3:00 a.m.,
 * nunca en otro horario ni en segundo plano. Antes, la descarga/actualización
 * de catálogo (que incluye precios oficiales — ver recordOfficialSaleResult
 * dentro de upsertNormalizedHips — y la media que la propia casa declara en
 * el catálogo) corría dentro de processSale(), en cada ciclo del scheduler
 * de 5 minutos, con una cadencia variable según pollingPolicy.ts. Ahora
 * corre acá, en un solo lugar, llamado UNA vez al día desde
 * scheduler.ts/runNightlySyncCycle (cron "0 3 * * *"), sin ninguna otra
 * cadencia posible. pollingPolicy.ts (shouldCheckNow/pollIntervalMinutes)
 * queda sin usar a propósito — no se borra, sigue siendo código válido por
 * si en el futuro hace falta volver a un chequeo más frecuente.
 *
 * ÚNICA EXCEPCIÓN (2026-08-17, mismo día, corrección posterior a pedido
 * explícito del propietario): el PRECIO de venta (Hip.saleResultJson), y
 * solo el precio, para la ventana de Decisión, y solo mientras esa venta
 * concreta esté en curso hoy, sí debe actualizarse en vivo cada 10
 * minutos — ver syncLivePricesForActiveSessions() más abajo, llamada desde
 * scheduler.ts/runLivePriceCycle (cron "*\/10 * * * *"). Catálogo, media y
 * calendario de TODAS las ventas (estén o no en curso) siguen sin tocarse
 * fuera de este job de las 3am — la excepción es única y exclusivamente el
 * precio de ventas en curso.
 */
export async function syncCatalogsForActiveSales(): Promise<void> {
  const sales = await db.sale.findMany({ where: { isActive: true, catalogAccess: "FULL" } });
  const now = new Date();
  for (const sale of sales) {
    try {
      await syncCatalog(sale);
    } catch (err) {
      // Mismo criterio que antes: catálogo todavía no publicado (200 con
      // body vacío) es un estado ESPERADO para ventas anunciadas con
      // anticipación — se loguea aparte, sin nivel "error". Cualquier otro
      // fallo (red, HTTP no-2xx, JSON roto de verdad) sigue yendo como
      // error real. Un fallo en una venta nunca debe impedir que se
      // sincronicen las demás.
      if (err instanceof CatalogNotYetPublishedError) {
        console.log(`[daily-sync] ${sale.name}: ${err.message}`);
        try {
          await flagInconclusiveIfCloseToSale(sale, now);
        } catch (flagErr) {
          console.error(`[daily-sync] Error marcando "${sale.name}" como inconclusa:`, flagErr);
        }
      } else {
        console.error(`[daily-sync] Error sincronizando catálogo de "${sale.name}":`, err);
      }
    } finally {
      try {
        await db.sale.update({ where: { id: sale.id }, data: { lastCatalogCheckAt: now } });
      } catch (updateErr) {
        console.error(`[daily-sync] Error actualizando lastCatalogCheckAt de "${sale.name}":`, updateErr);
      }
    }
  }
}

/**
 * Precio en vivo (2026-08-17, a pedido explícito del propietario): "lo
 * único que debe ser en tiempo real cada 10 minutos es el precio de venta,
 * en la ventana de Decisiones, mientras dicha venta esté en proceso, única
 * y exclusivamente allí, para todas las casas de ventas".
 *
 * "En proceso" se interpreta con el MISMO criterio de día calendario que ya
 * usa el resto del archivo para el Ranking del Día (ver
 * startOfCalendarDay/sessionExpiresAt): hoy es el día calendario de alguna
 * sessionDate de esta venta, hasta 2h después de terminada esa jornada. No
 * hay hora exacta de apertura/cierre de subasta en ninguna fuente — mismo
 * límite ya documentado en pollingPolicy.ts.
 *
 * No existe en ninguna casa de ventas un endpoint liviano de "solo
 * resultados" — la única forma de obtener el precio actualizado es
 * client.fetchCatalog(), igual que syncCatalog(). La diferencia real está
 * en qué se ESCRIBE después: acá se descarta todo excepto saleResult — NUNCA
 * se toca mediaJson, pedigree, Barn, ni ningún otro campo de catálogo, y
 * tampoco se dispara CATALOG_NOW_AVAILABLE, syncSaleDays, ni el refinado de
 * Sale.startDate (eso sigue siendo exclusivo del job de las 3am). Solo
 * aplica a ventas catalogAccess FULL: una venta MANUAL_CSV no tiene ningún
 * API contra la cual pedir un precio más nuevo que el último CSV importado.
 */
export async function syncLivePricesForSale(sale: Sale): Promise<{ hipsUpdated: number }> {
  const client = clientFor(sale.house);
  const hipCountBefore = await db.hip.count({ where: { saleId: sale.id } });
  const hips = await client.fetchCatalog(sale.externalSaleId, {
    name: sale.name,
    startDate: sale.startDate,
    hipCountBeforeSync: hipCountBefore,
  });

  let hipsUpdated = 0;
  for (const nh of hips) {
    if (!nh.saleResult) continue;
    const existing = await db.hip.findUnique({
      where: { saleId_hipNumber: { saleId: sale.id, hipNumber: nh.hipNumber } },
    });
    // Un Hip que todavía no está en nuestra base (catálogo no sincronizado
    // para él) no se crea acá — este ciclo NUNCA crea/descarga catálogo,
    // solo actualiza precio de Hips que el job de las 3am ya trajo.
    if (!existing) continue;

    const newResultJson = nh.saleResult as unknown as object;
    const unchanged = JSON.stringify(existing.saleResultJson ?? null) === JSON.stringify(newResultJson);
    if (unchanged) continue;

    const updatedHip = await db.hip.update({
      where: { id: existing.id },
      data: { saleResultJson: newResultJson },
    });
    hipsUpdated += 1;

    // Misma base histórica permanente que ya alimenta syncCatalog — un
    // precio nuevo en vivo también debe quedar reflejado ahí, no solo en
    // el Hip efímero de la venta activa.
    try {
      await recordOfficialSaleResult(updatedHip, sale);
    } catch (err) {
      console.error(`[live-price] Error registrando resultado oficial para Hip ${updatedHip.hipNumber}:`, err);
    }
  }
  return { hipsUpdated };
}

export interface LivePriceSyncSummary {
  salesInProgress: number;
  hipsUpdated: number;
  errors: string[];
}

/** Encuentra las ventas activas catalogAccess FULL cuya jornada de hoy está en curso, y les actualiza SOLO el precio (ver syncLivePricesForSale). */
export async function syncLivePricesForActiveSessions(): Promise<LivePriceSyncSummary> {
  const summary: LivePriceSyncSummary = { salesInProgress: 0, hipsUpdated: 0, errors: [] };
  const now = new Date();
  const sales = await db.sale.findMany({ where: { isActive: true, catalogAccess: "FULL" } });

  for (const sale of sales) {
    const sessionDates = await db.hip.findMany({
      where: { saleId: sale.id, sessionDate: { not: null } },
      distinct: ["sessionDate"],
      select: { sessionDate: true },
    });
    const inProgress = sessionDates.some(({ sessionDate }) => {
      if (!sessionDate) return false;
      return now.getTime() >= startOfCalendarDay(sessionDate).getTime() && now.getTime() < sessionExpiresAt(sessionDate).getTime();
    });
    if (!inProgress) continue;

    summary.salesInProgress += 1;
    try {
      const { hipsUpdated } = await syncLivePricesForSale(sale);
      summary.hipsUpdated += hipsUpdated;
    } catch (err) {
      // Igual criterio que el resto del archivo: catálogo todavía no
      // publicado no es un error real, el resto sí.
      if (err instanceof CatalogNotYetPublishedError) {
        console.log(`[live-price] ${sale.name}: ${err.message}`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[live-price] Error actualizando precio en vivo de "${sale.name}":`, err);
        summary.errors.push(`${sale.name}: ${message}`);
      }
    }
  }
  return summary;
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

  // CORRECCIÓN 2026-08-17 (a pedido explícito del propietario: "toda
  // actualización de precios de ventas, videos, fotos y descarga de
  // catálogos de nuevas ventas disponibles... no lo quiero en otro horario
  // ni en segundo plano"): la sincronización de catálogo (incluye precios
  // oficiales de venta y la media que la propia casa declara en el
  // catálogo) YA NO corre acá, en cada ciclo de 5 minutos del scheduler —
  // se movió a un job diario único a las 3:00 a.m. (ver
  // syncCatalogsForActiveSales más abajo, llamado desde
  // scheduler.ts/runNightlySyncCycle). Este ciclo de acá (processSale)
  // sigue corriendo cada 5 min SOLO para Análisis IA / Ranking del Día, que
  // no descarga nada de ninguna casa de ventas — solo recalcula sobre Hips
  // y fotos que ya están guardados. pollingPolicy.ts
  // (shouldCheckNow/pollIntervalMinutes) queda sin usar acá a propósito, no
  // se borró: sigue siendo código válido por si hace falta volver a un
  // chequeo más frecuente en el futuro.

  // Calendario de Ventas (SaleDay) — a pedido explícito (2026-08-14): "esto
  // no debe depender de que el usuario haga un resync manual". Por eso NO
  // se ata a shouldCheckNow/pollingPolicy de arriba (esa ventana existe
  // para no golpear de más la API de catálogo completo, mucho más pesada) —
  // corre en TODOS los ciclos del scheduler, pero el propio conteo de abajo
  // hace que solo pegue a la casa de ventas la primera vez que a esta venta
  // le falta calendario. Como el scheduler corre un ciclo inmediato al
  // arrancar (ver scheduler.ts), cualquier venta que ya tenga catálogo pero
  // todavía no tenga calendario lo resuelve sola en el siguiente redeploy,
  // sin esperar ningún intervalo largo.
  if (sale.catalogAccess === "FULL" || sale.catalogAccess === "MANUAL_CSV") {
    try {
      const existingSaleDayCount = await db.saleDay.count({ where: { saleId: sale.id } });
      if (existingSaleDayCount === 0) {
        if (sale.catalogAccess === "FULL") {
          await syncSaleDays(sale, clientFor(sale.house));
        } else {
          // MANUAL_CSV (ej. OBS, o Fasig-Tipton importado a mano sin ID de
          // API real todavía) — ver syncSaleDaysFromStoredHips arriba: no
          // hay API que consultar, así que se reintenta en cada ciclo del
          // scheduler igual que el camino FULL, hasta que algún import CSV
          // traiga Session Date real. Sigue siendo "ESPERA", nunca inventa.
          await syncSaleDaysFromStoredHips(sale);
        }
      }
    } catch (err) {
      console.error(`[scheduler] Error resolviendo Calendario de Ventas de ${sale.name}:`, err);
    }
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
