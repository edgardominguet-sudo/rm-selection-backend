import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisá el README para la lista completa.`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: requireEnv("DATABASE_URL"),
  // Se pide recién al usarla (no acá arriba), para que el servidor pueda
  // levantar y contestar /health aunque todavía no se haya cargado la key
  // — así Railway no marca el deploy como roto por un detalle de
  // configuración que se puede arreglar después sin re-deployar código.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  // Ya no se usa para comparar directamente (ver src/api/auth.ts: la clave
  // ahora resuelve un User real vía User.apiKey, sembrado con este mismo
  // valor — ver prisma/seed.ts). Se mantiene acá solo para que el
  // middleware sepa "se pretende tener autenticación configurada" y no
  // deje la API abierta en silencio si todavía no se corrió el seed.
  appApiKey: process.env.APP_API_KEY ?? "",
  // Cuántas horas antes del inicio de la sesión se debe generar el
  // Ranking del Día por primera vez.
  rankingLeadHours: Number(process.env.RANKING_LEAD_HOURS ?? 12),
  // Cada cuántos minutos corre el ciclo del scheduler (chequeo de nuevas
  // jornadas a generar + reanálisis incremental de Hips con media nueva).
  schedulerIntervalMinutes: Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? 15),
  topRankingSize: Number(process.env.TOP_RANKING_SIZE ?? 20),
  // Tope de seguridad: cuántos Hips se pueden analizar con IA como máximo
  // en UN ciclo del scheduler, sumando todas las ventas activas. Protege
  // contra un gasto descontrolado si un bug hiciera que muchos Hips
  // parecieran "cambiados" a la vez — los que no llegan a entrar
  // simplemente se retoman en el ciclo siguiente.
  maxAnalysesPerCycle: Number(process.env.MAX_ANALYSES_PER_CYCLE ?? 50),
  // Cada cuánto se revisan las páginas públicas de anuncios de Fasig-Tipton,
  // Keeneland y OBS en busca de ventas nuevas (ver saleDiscoveryService.ts)
  // — a propósito mucho más espaciado que el scheduler de análisis: una
  // casa de ventas anuncia eventos nuevos unas pocas veces por año, así que
  // chequear cada 6 horas alcanza de sobra y es respetuoso con sus
  // servidores. Formato cron estándar.
  discoveryIntervalCron: process.env.DISCOVERY_INTERVAL_CRON ?? "0 */6 * * *",
};
