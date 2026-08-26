import { SaleHouse } from "@prisma/client";
import { db } from "./db";
import { KeenelandDiscoveryClient } from "./saleHouses/discovery/keenelandDiscovery";
import { FasigTiptonDiscoveryClient } from "./saleHouses/discovery/fasigTiptonDiscovery";
import { OBSDiscoveryClient } from "./saleHouses/discovery/obsDiscovery";
import { SaleDiscoveryClient, DiscoveredSaleAnnouncement } from "./saleHouses/discovery/types";

const DISCOVERY_CLIENTS: Record<SaleHouse, SaleDiscoveryClient> = {
  KEENELAND: new KeenelandDiscoveryClient(),
  FASIG_TIPTON: new FasigTiptonDiscoveryClient(),
  OBS: new OBSDiscoveryClient(),
};

export interface DiscoveryRunSummary {
  found: number;
  created: number;
  errors: string[];
}

/**
 * Recorre las páginas públicas de anuncios de las tres casas de ventas,
 * filtra solo lo que todavía es futuro, y da de alta automáticamente
 * cualquier venta que no existiera ya (dedup por [house, externalSaleId] —
 * el mismo criterio que el alta manual). Pensado para correr con poca
 * frecuencia (ver DISCOVERY_INTERVAL_CRON en scheduler.ts): a diferencia
 * del chequeo de catálogo por Hip, una casa de ventas anuncia eventos
 * nuevos apenas un puñado de veces por año, así que no hace falta (ni es
 * respetuoso) consultar estas páginas cada pocos minutos.
 */
export async function runSaleDiscovery(): Promise<DiscoveryRunSummary> {
  const now = new Date();
  let found = 0;
  let created = 0;
  const errors: string[] = [];

  for (const house of Object.keys(DISCOVERY_CLIENTS) as SaleHouse[]) {
    const client = DISCOVERY_CLIENTS[house];
    let announcements: DiscoveredSaleAnnouncement[];
    try {
      announcements = await client.discoverAnnouncedSales(now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${house}: ${message}`);
      continue;
    }

    // Solo ventas futuras — el usuario pidió explícitamente que esto NO
    // reviva ni alerte ventas que ya pasaron, aunque el scraper las
    // encuentre igual (ej. el archivo de catálogos de Fasig-Tipton mezcla
    // pasadas y futuras del mismo año).
    const upcoming = announcements.filter((a) => a.startDate.getTime() >= now.getTime());
    found += upcoming.length;

    for (const announcement of upcoming) {
      try {
        const wasCreated = await registerDiscoveredSale(house, announcement);
        if (wasCreated) created += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${house} — ${announcement.name}: ${message}`);
      }
    }
  }

  return { found, created, errors };
}

/**
 * Da de alta una venta detectada si todavía no existe, y genera las
 * alertas correspondientes en la misma transacción. Devuelve true si se
 * creó una fila nueva (false si ya se conocía — no se re-alerta).
 */
async function registerDiscoveredSale(house: SaleHouse, announcement: DiscoveredSaleAnnouncement): Promise<boolean> {
  const existing = await db.sale.findUnique({
    where: { house_externalSaleId: { house, externalSaleId: announcement.externalSaleId } },
  });
  if (existing) {
    return updateExistingDiscoveredSale(existing, announcement);
  }

  // Segunda pasada de dedup, POR FECHA (2026-08-13): el `externalSaleId`
  // que trae un anuncio recién descubierto es casi siempre SINTÉTICO
  // (derivado del slug de la página pública) — no coincide con el ID REAL
  // que ya pueda tener una fila existente para ese mismo evento (cargada a
  // mano, o resuelta a mano en una corrida anterior de descubrimiento). Sin
  // este chequeo, la misma venta real termina con DOS filas: una con acceso
  // de verdad (FULL o MANUAL_CSV, con Hips) y otra "fantasma" en PENDING_ID
  // que nunca se sincroniza — confuso en /alerts y redundante. Se considera
  // "la misma venta" cuando es la misma casa y el primer día cae dentro de
  // una ventana de 3 días (cubre pequeñas diferencias entre "fecha del
  // anuncio" y "fecha real de la primera sesión" sin arriesgar mezclar dos
  // ventas distintas de la misma casa, que en la práctica nunca caen tan
  // cerca una de otra).
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const candidatesNearby = await db.sale.findMany({
    where: {
      house,
      startDate: {
        gte: new Date(announcement.startDate.getTime() - THREE_DAYS_MS),
        lte: new Date(announcement.startDate.getTime() + THREE_DAYS_MS),
      },
    },
  });
  const sameEvent = candidatesNearby.find((s) => s.catalogAccess === "FULL" || s.catalogAccess === "MANUAL_CSV");
  if (sameEvent) {
    return updateExistingDiscoveredSale(sameEvent, announcement);
  }

  await db.$transaction(async (tx) => {
    const createdSale = await tx.sale.create({
      data: {
        house,
        name: announcement.name,
        externalSaleId: announcement.externalSaleId,
        // Fecha tal como la trae el anuncio público — se va a refinar
        // sola con la fecha real de sesión apenas el catálogo esté
        // disponible (ver syncCatalog en rankingService.ts), pero esto ya
        // alcanza para ordenar cronológicamente entre casas desde el
        // momento en que se detecta el anuncio, incluso antes de que haya
        // catálogo.
        startDate: announcement.startDate,
        // Igual que startDate: se refina sola con la sessionDate más
        // tardía apenas el catálogo la resuelva (ver syncCatalog,
        // rankingService.ts). Si el anuncio no traía un rango (raro),
        // arranca igual a startDate para que la app nunca reciba un
        // endDate anterior al startDate.
        endDate: announcement.endDate ?? announcement.startDate,
        scheduleYear: announcement.scheduleYear,
        scheduleSlug: announcement.scheduleSlug,
        discoveredAt: new Date(),
        announcementUrl: announcement.announcementUrl,
        catalogAccess: announcement.access,
      },
    });

    await tx.saleAlert.create({
      data: {
        saleId: createdSale.id,
        kind: "NEW_SALE_DETECTED",
        message: buildDetectedMessage(house, createdSale.name, announcement.access),
      },
    });

    if (announcement.access === "FULL") {
      // El scheduler existente (rankingService.processSale, corrido desde
      // scheduler.ts) ya recorre TODAS las ventas con isActive=true — no
      // hace falta ningún paso extra para que esta arranque a
      // sincronizarse sola. Esta alerta solo deja trazado en
      // /api/v1/alerts que el proceso ya empezó.
      await tx.saleAlert.create({
        data: {
          saleId: createdSale.id,
          kind: "SYNC_STARTED",
          message: `RM Selection comenzó a sincronizar automáticamente el catálogo de "${createdSale.name}".`,
        },
      });
    }
  });

  return true;
}

/**
 * Una venta que el descubrimiento ya conocía (match exacto por
 * externalSaleId, o match "misma venta real" por fecha cercana — ver
 * arriba) recibe un anuncio de nuevo. Nunca se duplica: como mucho, se
 * completan campos que faltaban (scheduleYear/scheduleSlug) y se fuerza un
 * re-chequeo si eso desbloquea algo que antes no podía resolverse.
 */
async function updateExistingDiscoveredSale(
  existing: { id: string; scheduleYear: number | null; scheduleSlug: string | null },
  announcement: DiscoveredSaleAnnouncement
): Promise<boolean> {
  // Autocuración: filas dadas de alta antes de que el descubrimiento
  // supiera resolver scheduleYear/scheduleSlug (o alguna corrida vieja
  // que no los haya podido leer) quedan con esos campos null para
  // siempre — sin ellos, resolveKeenelandHipDates() nunca puede resolver
  // ninguna sessionDate, así que la venta queda con startDate:null y
  // afuera de la ventana de análisis, sin ningún error visible en los
  // logs (no es un fallo, simplemente nunca avanza). Como este anuncio
  // sí trae esos datos ahora, se completan solos en la fila existente; y
  // como el bloqueo real era la falta de esos campos (no el intervalo de
  // pollingPolicy), resetear lastCatalogCheckAt fuerza a que el próximo
  // tick del scheduler (máx. 5 min) reintente el catálogo ya mismo en
  // vez de esperar hasta el próximo chequeo programado.
  const missingScheduleInfo =
    (!!announcement.scheduleYear && !existing.scheduleYear) ||
    (!!announcement.scheduleSlug && !existing.scheduleSlug);
  if (missingScheduleInfo) {
    await db.sale.update({
      where: { id: existing.id },
      data: {
        scheduleYear: existing.scheduleYear ?? announcement.scheduleYear,
        scheduleSlug: existing.scheduleSlug ?? announcement.scheduleSlug,
        lastCatalogCheckAt: null,
      },
    });
  }
  return false;
}

function buildDetectedMessage(house: SaleHouse, name: string, access: "FULL" | "MANUAL_CSV" | "PENDING_ID" | "UNAVAILABLE"): string {
  const houseName = { FASIG_TIPTON: "Fasig-Tipton", KEENELAND: "Keeneland", OBS: "OBS" }[house];
  switch (access) {
    case "FULL":
      return `${houseName} publicó una venta nueva: "${name}". RM Selection la detectó automáticamente y ya está sincronizando su catálogo.`;
    case "PENDING_ID":
      return `${houseName} publicó una venta nueva: "${name}". Se detectó el anuncio, pero todavía falta cargar el ID de catálogo para que empiece a sincronizarse.`;
    case "MANUAL_CSV":
      return `${houseName} publicó una venta nueva: "${name}". ${houseName} no tiene una API de catálogo pública, así que hace falta subir el CSV/export del catálogo (POST /sales/${"{"}saleId${"}"}/catalog/import) para que empiece a analizarse — a partir de ahí, todo sigue automático.`;
    case "UNAVAILABLE":
      return `${houseName} publicó una venta nueva: "${name}". Por ahora no existe ningún método de acceso (ni automático ni manual) al catálogo de esta venta, así que solo queda registrada la alerta.`;
  }
}

