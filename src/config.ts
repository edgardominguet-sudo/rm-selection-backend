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

  // Almacenamiento de objetos para medios cargados por el usuario (fotos de
  // reporte veterinario, video/fotos propias) — sincronización
  // multidispositivo, 2026-08-08. Cloudflare R2 (API compatible con S3),
  // elegido por costo (sin cargo de egreso) y porque no exige ningún SDK
  // nuevo más allá de @aws-sdk/client-s3. Todos opcionales a propósito: sin
  // configurar, /me/media devuelve 503 en vez de romper el resto de la API
  // (mismo criterio que anthropicApiKey arriba) — así el resto del deploy
  // no queda bloqueado esperando que Ramon cree el bucket.
  r2AccountId: process.env.R2_ACCOUNT_ID ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  r2BucketName: process.env.R2_BUCKET_NAME ?? "",
  // URL pública (dominio propio o el *.r2.dev que da Cloudflare) desde
  // donde se puede LEER un objeto ya subido sin firmar nada — evita
  // generar una presigned URL de lectura en cada GET. Si no se configura,
  // se cae a una presigned URL de lectura (más lenta pero funciona igual).
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? "",

  // URL pública raíz de ESTE backend (sin barra final) — para construir
  // URLs propias que apuntan de vuelta al servidor, como las fotos del
  // caballo referente guardadas en Postgres (ver ReferenceHorsePhoto,
  // Tarea 1, 2026-08-10: vía alternativa mientras no haya R2). Default al
  // dominio conocido de Railway; override con PUBLIC_BASE_URL si el
  // dominio cambia (dominio propio, otro entorno, etc.).
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://rm-selection-backend-production.up.railway.app",
};

export function isObjectStorageConfigured(): boolean {
  return Boolean(config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2BucketName);
}
