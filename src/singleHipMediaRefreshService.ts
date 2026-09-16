import { db } from "./db";
import { clientFor } from "./saleHouses/registry";
import { mediaFingerprint } from "./analysis/mediaFingerprint";
import { countNewResources } from "./mediaSweepService";
import { CatalogMediaItem, CatalogNotYetPublishedError } from "./types";

/**
 * Refresco MANUAL de Media para UN SOLO Hip puntual (2026-09-16, a pedido
 * explícito de Ramon: "MEDIA: MANTENER BARRIDO AUTOMÁTICO + HABILITAR
 * REFRESCO MANUAL POR HIP"). Dos funciones que deben coexistir, sin que
 * una afecte a la otra:
 *
 *   - 3:00 a.m. = barrido automático GENERAL de toda venta activa —
 *     `mediaSweepService.runNightlyMediaSweep`, SIN NINGÚN CAMBIO. Este
 *     archivo no lo llama, no lo pausa, no comparte ningún estado con él
 *     (ni siquiera `MediaSweepRun`, ver abajo).
 *   - Cualquier hora del día = este archivo, para UN Hip puntual, mientras
 *     Ramon lo tiene abierto en la pestaña Media de la app.
 *
 * Deliberadamente NO reutiliza `runNightlyMediaSweep` con `saleId` acotado:
 * esa función, aunque se le pase una sola venta, sigue revisando TODOS los
 * Hips ya registrados de esa venta y encola análisis automático de IA
 * (`autoAnalyzeNewCatalogPhotoIfNeeded`) para cualquiera que tenga foto
 * pendiente — mucho más alcance del pedido ("SOLO para ese HIP") y un
 * costo de IA impredecible cada vez que alguien toca un botón. Esta
 * función:
 *   1) Pide el catálogo en vivo de la casa de ventas UNA vez (la propia
 *      API de la casa no ofrece consulta por Hip individual — no hay forma
 *      de evitar traer el JSON completo de la venta), pero SOLO lee y
 *      SOLO escribe el Hip pedido — ningún otro Hip de la respuesta se
 *      toca, ni se lee su fila existente siquiera.
 *   2) Descarga/actualiza en `Hip.mediaJson` únicamente lo que sea
 *      distinto a lo ya guardado (mismo criterio de huella/dedup por URL
 *      que el barrido general — `mediaFingerprint`/`countNewResources`,
 *      reutilizados tal cual, nunca duplica ni pisa media ya guardada que
 *      la fuente dejó de listar).
 *   3) NUNCA crea un `MediaSweepRun` ni toca `Sale.lastCatalogCheckAt` —
 *      esas dos cosas son del barrido general y de `syncCatalog`
 *      respectivamente; mezclarlas acá ensuciaría su historial con
 *      corridas de un solo Hip.
 *   4) NUNCA encola análisis automático de IA (`autoAnalyzeNewCatalogPhotoIfNeeded`)
 *      — a propósito: el pedido de Ramon es sobre MEDIA (fotos/video),
 *      no sobre disparar el análisis lateral cada vez que se toca este
 *      botón. Si el Hip tiene foto nueva, el barrido de las 3am la va a
 *      analizar como siempre, con su propio control de costo/concurrencia
 *      ya existente — este botón no necesita, y no debe, adelantar eso.
 *
 * Identificación de venta: 2026-09-16, corregido para seguir la MISMA
 * convención que el resto de la app (ver `RankingSaleIdentity` en el
 * cliente iOS y `router.post("/sales/resync", ...)` acá mismo) — la app
 * SIEMPRE identifica una venta por `house`+`externalSaleId`, nunca por el
 * id interno de Prisma, que la app no conoce. La primera versión de este
 * archivo tomaba `saleId` interno por error; quedó corregido antes de
 * conectar el lado iOS.
 *
 * Devuelve un resultado explícito (no `void`) para que la app pueda avisar
 * "Media actualizada" o "No hay contenido nuevo disponible" sin adivinar.
 */
export interface SingleHipMediaRefreshResult {
  ok: true;
  hipNumber: string;
  foundNewMedia: boolean;
  newPhotos: number;
  newVideos: number;
}

export interface SingleHipMediaRefreshNotPublished {
  ok: false;
  reason: "sale_not_yet_published";
  message: string;
}

export class SingleHipMediaRefreshError extends Error {}

export async function refreshSingleHipMediaFromLiveSource(opts: {
  house: string;
  externalSaleId: string;
  hipNumber: string;
}): Promise<SingleHipMediaRefreshResult | SingleHipMediaRefreshNotPublished> {
  const sale = await db.sale.findUnique({
    where: { house_externalSaleId: { house: opts.house as never, externalSaleId: opts.externalSaleId } },
  });
  if (!sale) {
    throw new SingleHipMediaRefreshError(`Venta ${opts.house}/${opts.externalSaleId} no encontrada.`);
  }
  if (sale.catalogAccess !== "FULL") {
    // Mismo criterio que runNightlyMediaSweep para una venta MANUAL_CSV:
    // no hay ninguna API en vivo legítima contra la que re-chequear un Hip
    // puntual — se informa como error claro, no como "sin contenido nuevo"
    // (evita que el usuario piense que ya se revisó y no había nada).
    throw new SingleHipMediaRefreshError(
      `${sale.name}: esta venta no tiene una fuente en vivo para re-chequear (catalogAccess=${sale.catalogAccess}).`
    );
  }

  const existingHip = await db.hip.findUnique({
    where: { saleId_hipNumber: { saleId: sale.id, hipNumber: opts.hipNumber } },
    select: { id: true, hipNumber: true, mediaJson: true },
  });
  if (!existingHip) {
    throw new SingleHipMediaRefreshError(`Hip ${opts.hipNumber} no está registrado todavía en RM Selection para esta venta.`);
  }

  const client = clientFor(sale.house);
  const hipCountBeforeSync = await db.hip.count({ where: { saleId: sale.id } });

  let liveHips: Awaited<ReturnType<typeof client.fetchCatalog>>;
  try {
    liveHips = await client.fetchCatalog(sale.externalSaleId, {
      name: sale.name,
      startDate: sale.startDate,
      hipCountBeforeSync,
    });
  } catch (err) {
    if (err instanceof CatalogNotYetPublishedError) {
      return {
        ok: false,
        reason: "sale_not_yet_published",
        message: err.message,
      };
    }
    throw err;
  }

  const fresh = liveHips.find((h) => h.hipNumber === opts.hipNumber);
  if (!fresh) {
    // El Hip existe en RM Selection pero la fuente en vivo, ahora mismo,
    // no lo lista (ej. lo retiraron de la venta) — no es un error técnico,
    // se informa como "sin contenido nuevo" en vez de tirar una excepción.
    return { ok: true, hipNumber: opts.hipNumber, foundNewMedia: false, newPhotos: 0, newVideos: 0 };
  }

  const freshMedia = fresh.media ?? [];
  const storedMedia = (Array.isArray(existingHip.mediaJson) ? existingHip.mediaJson : []) as unknown as CatalogMediaItem[];
  const mediaChanged = mediaFingerprint(freshMedia) !== mediaFingerprint(storedMedia);
  const { photos, videos } = countNewResources(freshMedia, storedMedia);

  if (mediaChanged) {
    await db.hip.update({
      where: { id: existingHip.id },
      data: { mediaJson: freshMedia as unknown as object },
    });
  }

  return {
    ok: true,
    hipNumber: opts.hipNumber,
    foundNewMedia: mediaChanged,
    newPhotos: photos,
    newVideos: videos,
  };
}
