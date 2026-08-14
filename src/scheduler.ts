import cron from "node-cron";
import { db } from "./db";
import { config } from "./config";
import { processSale, AnalysisBudget, cleanupExpiredRankingSnapshots } from "./rankingService";
import { runSaleDiscovery } from "./saleDiscoveryService";

// Evita que dos ciclos corran superpuestos: si analizar todos los Hips
// pendientes de un ciclo tarda más que el intervalo del próximo tick (algo
// real durante la jornada de venta, cuando el tick es cada 5 minutos y
// puede haber varios Hips para reanalizar), el segundo tick se salta en
// vez de arrancar un segundo ciclo en paralelo contra las mismas filas —
// eso podría duplicar versiones de análisis o pisarse entre sí.
let isRunning = false;

// Ver DIAGNÓSTICO TEMPORAL más abajo en runCycle().
let diagDumpDone = false;

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
    // DIAGNÓSTICO TEMPORAL (Calendario de Ventas / SaleDay): un solo dump,
    // una sola vez por arranque del proceso, de TODAS las ventas sin
    // filtrar — para confirmar por qué una venta no entra al ciclo
    // (isActive / catalogAccess) sin depender de acceso directo a la DB.
    // Se saca en cuanto quede diagnosticado.
    if (!diagDumpDone) {
      diagDumpDone = true;
      try {
        const allSales = await db.sale.findMany({
          select: { id: true, name: true, house: true, catalogAccess: true, isActive: true, scheduleYear: true, scheduleSlug: true },
        });
        for (const s of allSales) {
          console.log(`[diag-sales] "${s.name}" house=${s.house} catalogAccess=${s.catalogAccess} isActive=${s.isActive} scheduleYear=${s.scheduleYear ?? "null"} scheduleSlug=${s.scheduleSlug ?? "null"}`);
          const dayCount = await db.saleDay.count({ where: { saleId: s.id } });
          console.log(`[diag-sales]   -> SaleDay count = ${dayCount}`);
          if (dayCount > 0) {
            const sample = await db.saleDay.findMany({ where: { saleId: s.id }, orderBy: { date: "asc" }, take: 5 });
            for (const d of sample) {
              console.log(`[diag-sales]      ${d.date.toISOString().slice(0, 10)} book=${d.book ?? "null"} session=${d.sessionNumber ?? "null"} hips=${d.hipRangeStart ?? "?"}-${d.hipRangeEnd ?? "?"} source=${d.source}`);
            }
          }
        }
      } catch (err) {
        console.error("[diag-sales] Error listando ventas:", err);
      }
    }

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

// Mismo criterio de "no superponer ciclos" que el scheduler de análisis,
// pero como guard independiente — un descubrimiento lento (3 casas de
// ventas, una por una) no debería bloquear ni ser bloqueado por el ciclo
// de análisis, que corre mucho más seguido.
let discoveryIsRunning = false;

/**
 * Arranca el chequeo periódico de páginas públicas de anuncios (Fasig-Tipton,
 * Keeneland, OBS) para detectar ventas nuevas y darlas de alta solas — ver
 * saleDiscoveryService.ts. Corre en un cron SEPARADO del de análisis, a un
 * intervalo mucho más relajado (config.discoveryIntervalCron, 6h por
 * defecto): a diferencia de una foto/video nuevo en un Hip, una casa de
 * ventas anuncia eventos nuevos solo un puñado de veces por año.
 */
export function startDiscoveryScheduler(): void {
  cron.schedule(config.discoveryIntervalCron, () => {
    void runDiscoveryCycle();
  });

  console.log(`[discovery] Iniciado (cron: ${config.discoveryIntervalCron}).`);

  // Igual que el scheduler de análisis: primera corrida inmediata al
  // arrancar, para no depender del próximo tick del cron después de un
  // redeploy.
  void runDiscoveryCycle();
}

async function runDiscoveryCycle(): Promise<void> {
  if (discoveryIsRunning) {
    console.warn("[discovery] La corrida anterior todavía está en curso — se salta este tick.");
    return;
  }
  discoveryIsRunning = true;
  try {
    const summary = await runSaleDiscovery();
    if (summary.created > 0 || summary.errors.length > 0) {
      console.log(`[discovery] Encontradas: ${summary.found}, nuevas: ${summary.created}${summary.errors.length ? `, errores: ${summary.errors.join(" | ")}` : ""}`);
    }
  } catch (err) {
    console.error("[discovery] Error en la corrida de descubrimiento:", err);
  } finally {
    discoveryIsRunning = false;
  }
}
