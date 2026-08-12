export interface CatalogMediaItem {
  kind: "photo" | "video";
  url: string;
  caption?: string;
}

// Resultado de venta tal como lo va publicando la casa de ventas en vivo
// (precio, comprador, RNA/PS) — mismo criterio que RMSelection/Models/Hip.swift
// (SaleResult) del lado de la app.
export interface SaleResultData {
  priceRaw?: string;
  purchaser?: string;
  soldAsCode?: string; // "RNA", "PS", etc.
}

// Un Hip tal como lo entrega, ya normalizado, cualquier casa de ventas —
// el resto del backend (análisis, ranking) trabaja solo contra esta forma
// común, sin saber de dónde vino.
export interface NormalizedHip {
  hipNumber: string;
  horseName?: string;
  sex?: string;
  consignor?: string;
  sire?: string;
  dam?: string;
  damSire?: string;
  media: CatalogMediaItem[];
  saleResult?: SaleResultData;
  // Criador, año de nacimiento y color. Actualizado 2026-08-12: Keeneland
  // SÍ trae color (field_color) y fecha de nacimiento (field_foaling_date,
  // de la que se extrae foalYear) en su API de catálogo — ver
  // saleHouses/keeneland.ts. Breeder sigue sin venir de ninguna API en vivo
  // (Keeneland solo expone datos del consignor, no del criador; Fasig-Tipton
  // tampoco lo trae). Un import manual de catálogo (CSV/export, ver
  // saleHouses/manualCatalogImport.ts) puede seguir aportando estos tres
  // campos igual, porque son columnas estándar de esos exports.
  // Opcionales a propósito: cuando vienen undefined, upsertNormalizedHips
  // (rankingService.ts) NO toca el valor ya guardado — nunca se borra un
  // dato bueno cargado antes por no venir en esta fuente en particular.
  breeder?: string;
  foalYear?: number;
  color?: string;
}

// Lo que debe poder hacer el cliente de cualquier casa de ventas.
export interface SaleHouseClient {
  fetchCatalog(externalSaleId: string): Promise<NormalizedHip[]>;

  // hipNumber -> fecha de sesión (día calendario). Los Hips que no se
  // puedan resolver simplemente no aparecen en el mapa — nunca se
  // inventa una fecha. Devuelve un Map vacío si esta venta no tiene forma
  // de resolverlo automáticamente todavía.
  resolveSessionDates(
    externalSaleId: string,
    hips: NormalizedHip[],
    opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
  ): Promise<Map<string, Date>>;
}

// Se lanza cuando una casa de ventas contesta 200 OK pero con el body
// completamente vacío al pedir el catálogo de un sale — en la práctica,
// significa "todavía no publicamos el catálogo de esta venta", no un error
// de verdad (no es una caída de red, ni un 404/500, ni JSON corrupto). El
// scheduler la trata distinto: log informativo en vez de error, para no
// llenar los logs de "errores" repetidos por una venta que legítimamente
// no tiene datos todavía (ver rankingService.ts processSale).
export class CatalogNotYetPublishedError extends Error {
  constructor(house: string, externalSaleId: string) {
    super(`${house} todavía no publicó el catálogo del sale ${externalSaleId} (200 con body vacío).`);
    this.name = "CatalogNotYetPublishedError";
  }
}

export interface ConformationScoresJson {
  functional: Record<string, number>;
  limb: Record<string, number>;
  gait: Record<string, number>;
}
