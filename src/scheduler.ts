import cron from "node-cron";
import { db } from "./db";
import { config } from "./config";
import {
  processSale,
  syncCatalogsForActiveSales,
  syncLivePricesForActiveSessions,
  AnalysisBudget,
  cleanupExpiredRankingSnapshots,
} from "./rankingService";
import { runSaleDiscovery } from "./saleDiscoveryService";
import { runNightlyMediaSweep } from "./mediaSweepService";

// Evita que dos ciclos corran superpuestos: si analizar todos los Hips
// pendientes de un ciclo tarda más que el intervalo del próximo tick (algo
// real durante la jornada de venta, cuando el tick es cada 5 minutos y
// puede haber varios Hips para reanalizar), el segundo tick se salta en
// vez de arrancar un segundo ciclo en paralelo contra las mismas filas —
// eso podría duplicar versiones de análisis o pisarse entre sí.
let isRunning = false;

/**
 * El scheduler corre en el mismo proceso que la API (un solo servicio en
 * Railway). Cada tick (cada 5 minutos — el intervalo más fino que puede
 * llegar a hacer falta, jornada en curso) recorre las ventas activas; cada
 * una decide por su cuenta (ver rankingService.processSale / pollingPolicy)
 * si le toca chequear catálogo y/o generar-actualizar el ranking del día.
 *
 * Las ventas se procesan una por una (no en paralelo) a propósito: evita
 * mandar demasiadas requests simultáneas a la API de Anthropic cuando hay
 * varias jornadas por generar al mismo tiempo.
 */
export function startScheduler(): void {
  const cronExpression = "*/5 * * * *";

  cron.schedule(cronExpression, () => {
    void runCycle();
  });

  console.log(`[scheduler] Iniciado (tick cada 5 min, ventana de generación anticipada: ${config.rankingLeadHours}h antes de cada jornada).`);

  // Primer ciclo inmediato al arrancar, sin esperar el primer tick del
  // cron — así un redeploy no deja a la app sin datos frescos hasta el
  // próximo múltiplo de 5 minutos.
  void runCycle();
}

async function runCycle(): Promise<void> {
  if (isRunning) {
    console.warn("[scheduler] El ciclo anterior todavía está corriendo — se salta este tick.");
    return;
  }
  isRunning = true;

  const run = await db.schedulerRun.create({ data: {} });
  const budget: AnalysisBudget = { remaining: config.maxAnalysesPerCycle };
  let salesProcessed = 0;
  let firstError: string | null = null;

  try {
    const organizations = await db.organization.findMany({ select: { id: true } });
    // catalogAccess FULL o MANUAL_CSV — ambas pueden tener Hips cargados
    // (FULL los trae sola vía API; MANUAL_CSV los recibe por
    // POST /sales/:saleId/catalog/import) y por lo tanto algo para
    // analizar/rankear. PENDING_ID (falta ID real) y UNAVAILABLE (sin
    // ningún camino, ni manual) no tienen nada que sincronizar todavía; se
    // filtran acá para no contarlas como "procesadas" en SchedulerRun. Ver
    // también el guard equivalente en rankingService.processSale.
    const sales = await db.sale.findMany({ where: { isActive: true, catalogAccess: { in: ["FULL", "MANUAL_CSV"] } } });
    for (const sale of sales) {
      try {
        await processSale(sale, organizations, budget);
        salesProcessed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] Error procesando venta ${sale.name}:`, err);
        firstError = firstError ?? `${sale.name}: ${message}`;
      }
    }
    // Pedido explícito del usuario: 2h después de terminada la jornada,
    // borrar el Ranking del Día de esa venta. Va en un try/catch propio —
    // un fallo acá nunca debe impedir que se registre el resto del ciclo.
    try {
      const deleted = await cleanupExpiredRankingSnapshots();
      if (deleted > 0) {
        console.log(`[scheduler] Ranking del Día: ${deleted} jornada(s) vencida(s) borradas (2h post-venta).`);
      }
    } catch (err) {
      console.error("[scheduler] Error borrando Ranking del Día vencido:", err);
    }
  } finally {
    await db.schedulerRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        salesProcessed,
        analysesRun: config.maxAnalysesPerCycle - budget.remaining,
        errorMessage: firstError,
      },
    });
    isRunning = false;
  }
}

// Mismo criterio de "no superponer ciclos" que el scheduler de análisis.
let nightlySyncIsRunning = false;

/**
 * JOB NOCTURNO ÚNICO (2026-08-17, a pedido explícito del propietario):
 * "toda actualización de precios de ventas, videos, fotos y descarga de
 * catálogos de nuevas ventas disponibles" — antes repartido en tres
 * mecanismos con cadencias distintas (descubrimiento de ventas nuevas cada
 * 6h, sincronización de catálogo/precios dentro del ciclo de 5 min de
 * análisis, y barrido de Media ya a las 3am) — ahora corre TODO junto, una
 * sola vez al día, a las 3:00 a.m. hora del servidor (UTC en Railway), en
 * este orden fijo:
 *   1) descubrimiento de ventas nuevas (Fasig-Tipton/Keeneland/OBS) —
 *      ver saleDiscoveryService.ts;
 *   2) sincronización de catálogo (incluye precios oficiales de venta y la
 *      media que la propia casa declara) para toda venta activa con
 *      catalogAccess FULL — ver rankingService.syncCatalogsForActiveSales;
 *   3) barrido de Media (fotos/videos publicados por la casa fuera del
 *      catálogo) — ver mediaSweepService.ts.
 * A propósito NO corre una vez extra al arrancar el servidor (a diferencia
 * del scheduler de análisis de arriba): el pedido explícito fue "no lo
 * quiero en otro horario ni en segundo plano" — un redeploy a cualquier
 * hora del día no debe disparar esto fuera de las 3am. Cada paso va en su
 * propio try/catch: si uno falla, los otros dos igual corren.
 */
export function startNightlySyncScheduler(): void {
  cron.schedule("0 3 * * *", () => {
    void runNightlySyncCycle();
  });
  console.log("[nightly-sync] Iniciado (cron diario: 0 3 * * *, hora UTC del servidor) — descubrimiento + catálogo/precios + Media, un solo horario fijo, sin otra cadencia.");
}

async function runNightlySyncCycle(): Promise<void> {
  if (nightlySyncIsRunning) {
    console.warn("[nightly-sync] La corrida anterior todavía está en curso — se salta este tick.");
    return;
  }
  nightlySyncIsRunning = true;
  try {
    try {
      const summary = await runSaleDiscovery();
      console.log(`[nightly-sync][discovery] Encontradas: ${summary.found}, nuevas: ${summary.created}${summary.errors.length ? `, errores: ${summary.errors.join(" | ")}` : ""}`);
    } catch (err) {
      console.error("[nightly-sync][discovery] Error en el descubrimiento de ventas nuevas:", err);
    }

    try {
      await syncCatalogsForActiveSales();
      console.log("[nightly-sync][catalog] Sincronización de catálogo/precios completa.");
    } catch (err) {
      console.error("[nightly-sync][catalog] Error sincronizando catálogos/precios:", err);
    }

    try {
      const summary = await runNightlyMediaSweep({ trigger: "scheduled" });
      console.log(
        `[nightly-sync][media] runId=${summary.runId} Ventas revisadas: ${summary.salesChecked}, omitidas (sin catálogo en vivo): ${summary.salesSkipped}, Hips revisados: ${summary.hipsReviewed}, Hips con Media nueva: ${summary.hipsWithNewMedia}, recursos nuevos: ${summary.resourcesFound}${summary.errors.length ? `, errores: ${summary.errors.join(" | ")}` : ""}`
      );
    } catch (err) {
      console.error("[nightly-sync][media] Error en el barrido de Media:", err);
    }
  } finally {
    nightlySyncIsRunning = false;
  }
}

// Mismo criterio de "no superponer ciclos" que los dos schedulers de arriba.
let livePriceIsRunning = false;

/**
 * PRECIO EN VIVO cada 10 minutos (2026-08-17, corrección posterior a pedido
 * explícito del propietario, mismo día que el job nocturno de arriba):
 * "lo único que debe ser en tiempo real cada 10 minutos es el precio de
 * venta, en la ventana de Decisiones, mientras dicha venta esté en
 * proceso, única y exclusivamente allí, para todas las casas de ventas".
 *
 * Es la ÚNICA excepción a "todo a las 3am, nada en otro horario": el resto
 * (catálogo, media, descubrimiento de ventas nuevas) sigue siendo
 * exclusivo del job de arriba. Cada tick acá adentro es casi siempre un
 * no-op barato (una query) — solo hace algo si hay al menos una venta con
 * jornada en curso hoy, ver rankingService.syncLivePricesForActiveSessions.
 * A propósito NO corre una vez extra al arrancar el servidor (mismo
 * criterio que el job nocturno): el próximo tick del cron llega, como
 * mucho, 10 minutos después de cualquier redeploy.
 */
export function startLivePriceScheduler(): void {
  cron.schedule("*/10 * * * *", () => {
    void runLivePriceCycle();
  });
  console.log("[live-price] Iniciado (cron cada 10 min: */10 * * * *) — SOLO precio de venta (Hip.saleResultJson) de ventas con jornada en curso hoy, para la ventana de Decisión. No toca catálogo, media ni calendario.");
}

async function runLivePriceCycle(): Promise<void> {
  if (livePriceIsRunning) {
    console.warn("[live-price] La corrida anterior todavía está en curso — se salta este tick.");
    return;
  }
  livePriceIsRunning = true;
  try {
    const summary = await syncLivePricesForActiveSessions();
    if (summary.salesInProgress > 0) {
      console.log(
        `[live-price] Ventas en curso: ${summary.salesInProgress}, Hips con precio actualizado: ${summary.hipsUpdated}${summary.errors.length ? `, errores: ${summary.errors.join(" | ")}` : ""}`
      );
    }
  } catch (err) {
    console.error("[live-price] Error en el ciclo de precio en vivo:", err);
  } finally {
    livePriceIsRunning = false;
  }
}
