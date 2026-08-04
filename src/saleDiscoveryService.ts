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
  if (existing) return false;

  await db.$transaction(async (tx) => {
    const createdSale = await tx.sale.create({
      data: {
        house,
        name: announcement.name,
        externalSaleId: announcement.externalSaleId,
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

function buildDetectedMessage(house: SaleHouse, name: string, access: "FULL" | "PENDING_ID" | "UNAVAILABLE"): string {
  const houseName = { FASIG_TIPTON: "Fasig-Tipton", KEENELAND: "Keeneland", OBS: "OBS" }[house];
  switch (access) {
    case "FULL":
      return `${houseName} publicó una venta nueva: "${name}". RM Selection la detectó automáticamente y ya está sincronizando su catálogo.`;
    case "PENDING_ID":
      return `${houseName} publicó una venta nueva: "${name}". Se detectó el anuncio, pero todavía falta cargar el ID de catálogo para que empiece a sincronizarse.`;
    case "UNAVAILABLE":
      return `${houseName} publicó una venta nueva: "${name}". Por ahora no existe ningún método de acceso automático al catálogo de OBS, así que solo queda registrada la alerta.`;
  }
}

