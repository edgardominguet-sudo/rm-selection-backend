import { db } from "../db";

/**
 * Auto-resolución del ID numérico real de catálogo de Fasig-Tipton
 * (2026-08-17, a pedido explícito de Ramon: "cierra el hueco de fasig
 * tipton y obs" — tras la auditoría que confirmó este punto como PARCIAL).
 *
 * CONTEXTO: fasigTiptonDiscovery.ts detecta el ANUNCIO de una venta nueva
 * (nombre + fecha + URL pública, en Sale.announcementUrl) pero NO puede
 * leer el ID numérico interno que pide la API de catálogo
 * (`django/api/horses/?sale={id}`), porque ese ID nunca aparece en el HTML
 * que devuelve el servidor. Se confirmó con evidencia en vivo (navegador
 * real + inspección de network requests, 2026-08-17) que ni siquiera una
 * venta EN CURSO (New York Bred Yearlings, con la jornada corriendo ese
 * mismo día) lo expone en el HTML estático — se probó pidiendo la página
 * con un fetch plano (sin ejecutar JavaScript) y la sección "Results" viene
 * vacía en el HTML, sin ningún ID ni JSON embebido en ningún <script>. La
 * pestaña la llena 100% JavaScript del lado del cliente. Sin ejecutar ese
 * JavaScript no hay forma de leerlo — un fetch() común (lo que usa el
 * resto del descubrimiento) nunca lo va a encontrar, sin importar cuán
 * cerca esté la fecha de la venta.
 *
 * SOLUCIÓN: un navegador headless real (Chromium vía puppeteer-core +
 * @sparticuz/chromium) que carga la página pública de la venta e
 * intercepta la request que el propio sitio hace a
 * `django/api/horses/?sale={id}` cuando esa pestaña está disponible. Esto
 * NO es fuerza bruta ni evasión de ninguna protección: es exactamente la
 * misma request que hace el navegador de cualquier visitante humano —
 * solo se automatiza la lectura, nunca se inventa ni se adivina el número.
 * (Distinto de OBS: obscatalog.com devuelve 403 Forbidden incluso a un
 * navegador real desde la raíz del sitio — eso sí es una protección activa
 * y no se intenta evadir, por eso OBS se documenta aparte como no
 * implementable.)
 *
 * LÍMITE REAL CONFIRMADO: Fasig-Tipton solo activa esa pestaña (y por lo
 * tanto esa request) más cerca de la venta / cuando publica el catálogo —
 * para una venta todavía lejana (ej. Kentucky October Yearlings, con más
 * de 2 meses de anticipación) la página pública hoy SOLO trae "Sale Info"
 * y "Recent Graduates", sin pestaña Results/Bid Online/Catalogue, así que
 * no hay ninguna request que interceptar todavía. Este resolver por eso NO
 * resuelve el ID en el momento del anuncio — lo resuelve automáticamente
 * en cuanto el propio Fasig-Tipton lo hace disponible, sin que Ramon tenga
 * que revisar manualmente. Hasta ese momento, la venta sigue PENDING_ID
 * (detectada, visible, esperando) — igual que hoy, solo que ahora nadie
 * tiene que ir a buscar el ID a mano una vez que aparece.
 *
 * CUÁNDO CORRE: una vez al día, dentro del job nocturno de las 3am (ver
 * scheduler.ts), después del descubrimiento y antes de la sincronización
 * de catálogo — así una venta recién resuelta esta noche ya sincroniza su
 * catálogo esta misma corrida. Una venta PENDING_ID a la vez, cerrando el
 * navegador entre cada una (nunca dos instancias de Chromium en paralelo)
 * para no acumular memoria — el servicio tiene ~870MB libres de 1GB, y una
 * instancia de Chromium headless de corta duración usa un margen chico de
 * eso, pero no hay necesidad de correr más de una a la vez.
 */
export async function autoResolvePendingFasigTiptonSaleIds(): Promise<{
  checked: number;
  resolved: number;
  errors: string[];
}> {
  const pending = await db.sale.findMany({
    where: { house: "FASIG_TIPTON", catalogAccess: "PENDING_ID", isActive: true },
  });

  let resolved = 0;
  const errors: string[] = [];

  for (const sale of pending) {
    if (!sale.announcementUrl) continue;
    try {
      const realId = await extractFasigTiptonSaleId(sale.announcementUrl);
      if (realId != null) {
        await db.sale.update({
          where: { id: sale.id },
          data: { externalSaleId: String(realId), catalogAccess: "FULL", lastCatalogCheckAt: null },
        });
        resolved += 1;
        console.log(
          `[fasig-tipton-id-resolver] Resuelto automáticamente: "${sale.name}" → externalSaleId=${realId} (catalogAccess ahora FULL, se sincroniza en esta misma corrida).`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${sale.name}: ${message}`);
      console.error(`[fasig-tipton-id-resolver] Error resolviendo "${sale.name}" (${sale.announcementUrl}):`, err);
    }
  }

  return { checked: pending.length, resolved, errors };
}

/**
 * Carga `pageUrl` en un Chromium headless real y devuelve el ID numérico
 * de la venta si el sitio ya lo expuso vía la request
 * `django/api/horses/?sale={id}` — o `null` si esa pestaña todavía no está
 * disponible (venta lejana, catálogo no publicado todavía). No lanza error
 * en ese caso — "todavía no disponible" es un resultado válido y esperado,
 * no una falla.
 *
 * Expuesta (no default-only) para poder probarla puntualmente desde un
 * endpoint de diagnóstico sin tocar ninguna venta real — ver
 * POST /_diag/resolve-fasig-id en routes.ts.
 */
export async function extractFasigTiptonSaleId(pageUrl: string): Promise<number | null> {
  // Tipado laxo (any) a propósito en todo este bloque: puppeteer-core y
  // @sparticuz/chromium no se pueden instalar/verificar con tsc desde este
  // entorno de desarrollo (registro npm bloqueado acá) — se prioriza que la
  // lógica sea correcta en runtime (API estable de Puppeteer desde hace
  // años) por sobre depender de la forma exacta de sus tipos, que sí se
  // valida en el build real de Railway.
  const chromiumModule: any = await import("@sparticuz/chromium");
  const chromium = chromiumModule.default ?? chromiumModule;
  const puppeteer: any = await import("puppeteer-core");

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    let foundId: number | null = null;

    page.on("request", (request: any) => {
      const match = /\/django\/api\/horses\/\?sale=(\d+)/.exec(request.url());
      if (match) {
        foundId = Number(match[1]);
      }
    });

    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 25000 });

    // Si la pestaña relevante no dispara la request sola al cargar (se
    // observó que a veces requiere un click, ver investigación
    // 2026-08-17), se intenta un click best-effort sobre cualquier enlace
    // visible con ese texto — sin fallar si no existe: eso simplemente
    // significa que la venta todavía no tiene esa pestaña disponible.
    if (foundId == null) {
      const links = await page.$$("a");
      for (const link of links) {
        const text = ((await page.evaluate((el: any) => el.textContent, link)) ?? "").trim();
        if (/^(Results|Catalogue|Bid Online)$/i.test(text)) {
          try {
            await link.click();
            await page.waitForNetworkIdle({ timeout: 8000, idleTime: 1000 }).catch(() => {});
          } catch {
            // best-effort — un click que falla (login requerido, elemento
            // no interactuable, etc.) simplemente no resuelve esta vez.
          }
          if (foundId != null) break;
        }
      }
    }

    return foundId;
  } finally {
    await browser.close();
  }
}
