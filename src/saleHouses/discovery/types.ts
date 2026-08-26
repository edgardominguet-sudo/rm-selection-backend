// Tipos compartidos por los clientes de DESCUBRIMIENTO de ventas nuevas —
// distinto de SaleHouseClient (types.ts en la carpeta padre), que asume que
// la venta ya existe y solo trae su catálogo. Estos clientes en cambio leen
// las páginas PÚBLICAS de anuncios/calendario de cada casa de ventas para
// detectar que una venta nueva empezó a existir, antes de que nadie la haya
// dado de alta a mano.

export interface DiscoveredSaleAnnouncement {
  /** Nombre de la venta tal como lo publica la casa de ventas. */
  name: string;
  /**
   * ID a usar en Sale.externalSaleId. Real (utilizable con la API de
   * catálogo) cuando access === "FULL"; sintético (derivado del slug del
   * anuncio) en cualquier otro caso — ver comentario en Sale.catalogAccess,
   * schema.prisma.
   */
  externalSaleId: string;
  /** Primer día de la venta — se usa para filtrar anuncios ya pasados. */
  startDate: Date;
  /**
   * Último día calendario de la venta, si se pudo leer un rango (ej.
   * "Sept. 14 - 26, 2026") — ver dateParsing.findDateRange. undefined =
   * no se pudo leer ningún rango; el llamador (saleDiscoveryService) usa
   * entonces startDate también como endDate en vez de dejarlo vacío, para
   * que la app siempre reciba un rango válido.
   */
  endDate?: Date;
  announcementUrl: string;
  access: "FULL" | "MANUAL_CSV" | "PENDING_ID" | "UNAVAILABLE";
  /** Solo Keeneland: para resolveSessionDates (Schedule of Sale). */
  scheduleYear?: number;
  scheduleSlug?: string;
}

export interface SaleDiscoveryClient {
  /**
   * Lee la página pública de anuncios/calendario de la casa de ventas y
   * devuelve las ventas encontradas — el llamador (saleDiscoveryService)
   * es responsable de filtrar solo futuras y de no duplicar ventas ya
   * dadas de alta.
   */
  discoverAnnouncedSales(now: Date): Promise<DiscoveredSaleAnnouncement[]>;
}
