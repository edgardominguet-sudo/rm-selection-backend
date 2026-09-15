/**
 * Reintento con backoff corto para pedidos HTTP a las APIs externas de
 * casas de venta (2026-09-15, a pedido explícito de Ramon: "Quiero ver el
 * precio de los hip que se venden en el dia en tiempo real durante la
 * venta, ese mecanismo ya estaba activo en la venta pasada y por alguna
 * razon no se disparo hoy con los Hip vendidos, revisalo, corrigelo y
 * activalo").
 *
 * INVESTIGADO contra los logs reales de Railway del 2026-09-14: el
 * mecanismo de precio en vivo (syncLivePricesForActiveSessions,
 * rankingService.ts, cron cada 10 min) funcionó correctamente durante
 * CASI toda la sesión en vivo de September Yearling Sale — decenas de
 * Hips actualizados en tiempo real entre las 18:00 y las 22:10 UTC. Pero
 * entre las 17:00 y las 17:50 UTC — justo cuando arrancó esa sesión en
 * vivo, con tráfico real masivo de compradores entrando a keeneland.com
 * al mismo tiempo — catalog-backend.keeneland.com devolvió una racha de
 * errores 5xx de Cloudflare (522 Connection timed out, 503 rate limited,
 * 521 Web server is down, 502 Bad gateway): el origen de Keeneland estaba
 * saturado por su propio tráfico real, no por nuestro pedido. Como antes
 * no había ningún reintento, CADA UNO de esos ciclos de 10 minutos se
 * quedaba sin ningún dato — la próxima oportunidad de detectar un Hip
 * recién vendido en esa ventana era recién el ciclo siguiente, hasta 10-20
 * minutos después. Ningún precio se perdía DEFINITIVAMENTE (el próximo
 * fetch exitoso siempre trae el delta completo, por comparación contra lo
 * ya guardado — ver syncLivePricesForSale), pero la pantalla de Decisión
 * se quedaba sin el precio de Hips ya vendidos durante esa ventana — este
 * es, con alta probabilidad, exactamente lo que Ramon vio y reportó.
 *
 * Mismo patrón ya probado en producción para la API de Anthropic
 * (sendWithRetry, analysis/landmarkVisionClient.ts): reintentar un puñado
 * de veces, con una pausa corta creciente, SOLO ante errores que son
 * transitorios por naturaleza (5xx de servidor/proxy, o un fallo de red de
 * bajo nivel como timeout/reset/DNS — fetch() los lanza como excepción,
 * nunca como response.status) — nunca ante un 4xx (ese es un error real,
 * reintentar no lo arregla, y syncCatalog ya distingue aparte el caso "200
 * con body vacío" = catálogo todavía no publicado, ver
 * CatalogNotYetPublishedError). Así, un error pasajero de Cloudflare se
 * resuelve solo DENTRO del mismo ciclo de 10 minutos (en pocos segundos),
 * en vez de esperar al próximo cron.
 *
 * Reutilizable por cualquier casa de venta (hoy: Keeneland, Fasig-Tipton)
 * — mismo contrato que fetch(), así que reemplaza esa llamada sin tocar
 * nada más del parseo/manejo de cada cliente.
 */
export interface FetchWithRetryOptions {
  /** Intentos totales, incluyendo el primero. Default 4 (1 + 3 reintentos). */
  maxAttempts?: number;
  /** Pausa base en ms, crece linealmente por intento (mismo criterio que sendWithRetry: intento * baseDelayMs). Default 1500ms. */
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1500;

function isRetryableStatus(status: number): boolean {
  // Cualquier 5xx (Cloudflare puede devolver 502/503/504/521/522/524,
  // etc., según dónde falle exactamente) es por definición un problema del
  // lado del servidor/proxy, nunca de lo que nosotros pedimos — reintentar
  // tiene sentido. Un 4xx (400/401/403/404/...) es un error real sobre
  // nuestro propio pedido — reintentar el mismo pedido nunca lo arregla.
  return status >= 500 && status <= 599;
}

export async function fetchWithRetry(url: string, init: RequestInit, opts: FetchWithRetryOptions = {}, attempt = 1): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  try {
    const response = await fetch(url, init);
    if (isRetryableStatus(response.status) && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
      return fetchWithRetry(url, init, opts, attempt + 1);
    }
    return response;
  } catch (err) {
    // Fallo de red de bajo nivel (timeout, ECONNRESET, DNS, etc.) — mismo
    // criterio: reintentar, nunca colgar el ciclo entero por un solo
    // pedido fallido.
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
      return fetchWithRetry(url, init, opts, attempt + 1);
    }
    throw err;
  }
}
