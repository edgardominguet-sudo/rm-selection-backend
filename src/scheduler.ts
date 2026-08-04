import cron from "node-cron";
import { db } from "./db";
import { config } from "./config";
import { processSale, AnalysisBudget } from "./rankingService";
import { runSaleDiscovery } from "./saleDiscoveryService";

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
    // catalogAccess: "FULL" — las ventas detectadas automáticamente sin ID
    // de catálogo resuelto (PENDING_ID) o sin método de acceso conocido
    // (UNAVAILABLE) no tienen nada que sincronizar todavía; se filtran acá
    // para no contarlas como "procesadas" en SchedulerRun. Ver también el
    // guard equivalente en rankingService.processSale.
    const sales = await db.sale.findMany({ where: { isActive: true, catalogAccess: "FULL" } });
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
