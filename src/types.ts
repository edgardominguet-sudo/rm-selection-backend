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

export interface ConformationScoresJson {
  functional: Record<string, number>;
  limb: Record<string, number>;
  gait: Record<string, number>;
}
