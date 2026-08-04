import { NormalizedHip, SaleHouseClient } from "../types";

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
}
