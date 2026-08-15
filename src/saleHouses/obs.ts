import { NormalizedHip, ResolvedSaleDay, SaleHouseClient } from "../types";
import { resolveSaleDaysFromSessionDates } from "./sessionDateSaleDays";

// OBS (Ocala Breeders' Sales) — NO HAY todavía ninguna integración de
// catálogo real, ni en el backend ni en la app de iOS (se confirmó
// explícitamente en una sesión anterior: no existe ningún servicio ni
// endpoint conocido para OBS en el código existente). Este cliente es un
// punto de extensión documentado, no una integración funcional: deja la
// arquitectura lista (mismo contrato SaleHouseClient que Fasig-Tipton y
// Keeneland) para el día que se investigue y confirme cómo publica OBS su
// catálogo — pero hoy tira un error claro en vez de simular datos.
export class OBSClient implements SaleHouseClient {
  async fetchCatalog(_externalSaleId: string): Promise<NormalizedHip[]> {
    throw new Error(
      "OBS todavía no tiene una integración de catálogo implementada. " +
        "Hace falta investigar el endpoint/formato real que usa OBS antes de poder darla de alta acá."
    );
  }

  async resolveSessionDates(): Promise<Map<string, Date>> {
    return new Map();
  }

  // Arquitectura del Calendario de Ventas dejada LISTA para OBS (a pedido,
  // 2026-08-15: "aunque en este momento no haya que introducir manualmente
  // una venta específica de OBS"). Usa el mismo helper genérico que
  // Fasig-Tipton — hoy resolveSessionDates() de arriba siempre devuelve un
  // Map vacío (no hay integración de catálogo real todavía), así que esto
  // simplemente devuelve [] sin error. El día que se dé de alta la
  // integración real de catálogo de OBS y resolveSessionDates() empiece a
  // devolver fechas reales, este método empieza a producir el calendario
  // automáticamente, sin tocar nada más.
  async resolveSaleDays(): Promise<ResolvedSaleDay[]> {
    const sessionDates = await this.resolveSessionDates();
    return resolveSaleDaysFromSessionDates(sessionDates, "OBS_CATALOG_SESSION_FIELD");
  }
}
