/**
 * Pool de concurrencia simple, sin dependencias externas (2026-09-10, a
 * pedido explícito de Ramon: procesar TODAS las fotos pendientes de una
 * corrida "de forma paralela/concurrente de manera segura... usando un
 * nivel de concurrencia que el backend y la API puedan soportar sin
 * errores"). Patrón estándar de "N workers toman el próximo item de la
 * cola apenas terminan el anterior" — evita tanto la secuencia 100%
 * uno-a-la-vez (lenta) como lanzar TODO junto con `Promise.all` sin
 * límite (satura la base de datos y la API de análisis de golpe).
 *
 * Un error dentro de `worker` para UN item NO detiene el resto del lote
 * — se espera que `worker` capture sus propios errores si no debe
 * interrumpir el procesamiento de los demás items (ver
 * `autoAnalyzeNewCatalogPhotoIfNeeded`, que ya nunca tira excepción hacia
 * arriba).
 */
export async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));

  let nextIndex = 0;
  async function runOneWorker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => runOneWorker()));
}
