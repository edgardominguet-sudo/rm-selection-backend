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
    // Establo (Barn) tal como lo publica la casa de ventas — CORRECCIÓN
  // 2026-08-15: campo permanente del modelo de dominio (Hip.barn en la
  // app) que nunca se agregó acá al generalizar el importador por casa,
  // así que se perdía en toda venta nueva sin importar la fuente
  // (API en vivo o CSV manual). Cada casa lo completa si su fuente lo
  // trae (ver saleHouses/fasigTipton.ts, keeneland.ts,
  // manualCatalogImport.ts); si no lo trae, queda undefined y
  // upsertNormalizedHips no toca el valor ya guardado.
  barn?: string;
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

// Contexto opcional de la venta que algún cliente puede necesitar además
// del externalSaleId (hoy solo lo usa KeenelandClient, para el mecanismo
// de respaldo por PDF de pedigree — ver keenelandPedigreePdfCatalog.ts).
// Opcional en la firma para no afectar a FasigTiptonClient/ObsClient, que
// lo ignoran.
export interface SaleFetchContext {
    name: string;
    startDate: Date | null;
    hipCountBeforeSync: number;
    // CORRECCIÓN 2026-08-17: el mecanismo de respaldo por PDF de pedigree de
  // Keeneland (ver keenelandPedigreePdfCatalog.ts) solo corría la PRIMERA
  // vez que una venta aparecía sin ningún Hip todavía (hipCountBeforeSync
  // === 0) — pensado para no volver a probar miles de PDFs en cada ciclo
  // del scheduler. Problema real encontrado: un bug de extracción de Barn
  // (corregido 2026-08-15, ver parseKeenelandPedigreePdfText) se arregló
  // DESPUÉS de que Keeneland September ya se hubiera importado por
  // completo (4640 Hips) — así que el fix nunca se aplicó a los datos ya
  // guardados, y como el probing solo corre una vez, no había forma
  // automática de que se volviera a ejecutar y corregir el Barn ya
  // guardado. `forcePdfProbe` permite saltarse ese guard SOLO cuando se
  // pide explícitamente (ver POST/GET /sales/.../resync?forcePdfProbe=true
  // en routes.ts) — nunca lo activa el scheduler automático, para no volver
  // pesado cada ciclo de 5 min.
  forcePdfProbe?: boolean;
}

// Una jornada real de venta (día de subasta) tal como la publica la casa
// de ventas, para el "Calendario de Ventas" de la app — ver SaleDay en
// schema.prisma. Genérico por casa: cada campo opcional que una casa no
// pueda resolver todavía se deja undefined (nunca se inventa).
export interface ResolvedSaleDay {
    date: Date;
    book?: string;
    sessionNumber?: number;
    startTimeLabel?: string;
    hipRangeStart?: string;
    hipRangeEnd?: string;
    headCount?: number;
    // De dónde salió esta fila (ej. "KEENELAND_HIP_GROUPING_PDF") — para
  // poder diagnosticar sin adivinar cuando el dato se vea raro.
  source: string;
}

// Lo que debe poder hacer el cliente de cualquier casa de ventas.
export interface SaleHouseClient {
    fetchCatalog(externalSaleId: string, ctx?: SaleFetchContext): Promise<NormalizedHip[]>;

  // hipNumber -> fecha de sesión (día calendario). Los Hips que no se
  // puedan resolver simplemente no aparecen en el mapa — nunca se
  // inventa una fecha. Devuelve un Map vacío si esta venta no tiene forma
  // de resolverlo automáticamente todavía.
  resolveSessionDates(
      externalSaleId: string,
      hips: NormalizedHip[],
      opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
    ): Promise<Map<string, Date>>;

  // Calendario completo de la venta (Fecha → Libro → rango de Hip) para
  // el Calendario de Ventas. Optativo: una casa que todavía no sepa
  // resolverlo simplemente no implementa este método — el calendario de
  // esa venta queda vacío, sin error (ver keenelandHipGrouping.ts para la
  // única implementación real hoy).
  resolveSaleDays?(
      externalSaleId: string,
      opts: { scheduleYear?: number | null; scheduleSlug?: string | null }
    ): Promise<ResolvedSaleDay[]>;
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

// Forma nueva (2026-08-13, methodologyVersion = "rm-anatomical-2026-08") —
// mapa PLANO id -> puntaje con las 9 claves con punto (lateral.proportions,
// etc.), ver src/analysis/conformationScores.ts (ConformationScores) para
// la versión canónica; esta interfaz es solo para referencia/tipado
// externo. Filas legado (methodologyVersion = null) también son planas,
// con las 26 claves viejas (functional.*/limb.*/gait.*).
export type ConformationScoresJson = Record<string, number>;
