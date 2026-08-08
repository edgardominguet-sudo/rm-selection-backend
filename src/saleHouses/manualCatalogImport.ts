import { db } from "../db";
import { CatalogImport } from "@prisma/client";
import { CatalogMediaItem, NormalizedHip, SaleResultData } from "../types";
import { upsertNormalizedHips, UpsertSummary } from "../rankingService";

// Camino de catálogo para ventas SaleCatalogAccess.MANUAL_CSV — hoy, OBS (ver
// comentario en schema.prisma): no existe ninguna API pública de catálogo,
// así que en vez de dejar la venta permanentemente sin sincronizar, el
// catálogo se carga a mano una vez por jornada (o cada vez que se quiera
// refrescar fotos/video/resultados) subiendo el export/CSV que la propia
// casa de ventas ya distribuye a consignatarios y compradores — mismo
// formato, sin inventar ningún dato nuevo. A partir de ahí, el Hip generado
// entra por la MISMA puerta (upsertNormalizedHips) que un Hip de Keeneland o
// Fasig-Tipton: mismo análisis con IA, mismo Ranking del Día, mismo
// Historial de Ventas, misma detección de "media cambió" en el próximo
// import (por el hash de mediaFingerprint, que no distingue el origen).
//
// Este parser es intencionalmente tolerante: una fila con datos faltantes o
// mal formados nunca tira abajo el import completo (se descarta esa fila
// puntual con una advertencia) — preferible a que un solo error de tipeo en
// una planilla de 300 filas bloquee las otras 299.

export class EmptyManualCatalogError extends Error {
  constructor() {
    super("El archivo no tiene ninguna fila con datos (o está vacío).");
    this.name = "EmptyManualCatalogError";
  }
}

export class MissingHipNumberColumnError extends Error {
  constructor() {
    super('El archivo no tiene ninguna columna reconocible como "Hip Number".');
    this.name = "MissingHipNumberColumnError";
  }
}

export interface ManualCatalogParseResult {
  hips: NormalizedHip[];
  sessionDates: Map<string, Date>;
  warnings: string[];
}

// Alias aceptados por columna lógica — cada casa de ventas (y cada versión
// de su export) nombra las columnas un poco distinto; en vez de exigir un
// formato único y rígido, se acepta cualquiera de estos nombres (case
// insensitive, espacios y guiones normalizados).
const COLUMN_ALIASES: Record<string, string[]> = {
  hipNumber: ["hip number", "hip #", "hip no", "hip", "lot", "lot number"],
  horseName: ["horse name", "horse", "name"],
  sex: ["sex"],
  sire: ["sire"],
  dam: ["dam"],
  damSire: ["dam sire", "broodmare sire", "sire of dam"],
  consignor: ["consignor", "consignor name"],
  breeder: ["breeder", "bred by"],
  foalYear: ["foal year", "foaling year", "year foaled", "yob"],
  color: ["color", "colour"],
  sessionDate: ["session date", "sale date", "session", "day"],
  price: ["sale price", "price", "hip price"],
  purchaser: ["buyer", "purchaser"],
  soldAsCode: ["sale status", "sold as", "result", "rna/ps", "status"],
};

function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^﻿/, "") // BOM inicial, típico de exports de Excel
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/** Parser de una línea CSV con soporte de comillas dobles (RFC4180: "" dentro de comillas = una comilla literal). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (insideQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          insideQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      insideQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parsea el texto completo de un CSV de catálogo a NormalizedHip[] — mismo
 * formato de salida que cualquier SaleHouseClient.fetchCatalog, para poder
 * reutilizar upsertNormalizedHips sin ninguna rama especial.
 *
 * Columnas de foto/video: cualquier columna cuyo nombre empiece con "photo"
 * o "video" (después de normalizar) se toma como una URL de media — se
 * pueden repetir tantas columnas "Photo URL", "Photo URL 2", "Walking
 * Video", "UT Video", etc. como haga falta; todas las que tengan un valor
 * no vacío se agregan, en el orden en que aparecen en el header. Esto cubre
 * el caso real de OBS (Walking Video + UT Video + Photo separadas) sin
 * exigir un formato rígido de columnas fijas.
 */
export function parseManualCatalogCsv(csvText: string): ManualCatalogParseResult {
  const lines = csvText
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) throw new EmptyManualCatalogError();

  const headerRaw = parseCsvLine(lines[0]).map(normalizeHeader);
  const columnIndex = new Map<string, number>();
  const photoColumns: number[] = [];
  const videoColumns: number[] = [];

  headerRaw.forEach((header, index) => {
    for (const [logical, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(header) && !columnIndex.has(logical)) {
        columnIndex.set(logical, index);
      }
    }
    if (/^photo/.test(header)) photoColumns.push(index);
    if (/^(video|walking video|ut video|under\s?tack)/.test(header)) videoColumns.push(index);
  });

  const hipNumberIdx = columnIndex.get("hipNumber");
  if (hipNumberIdx === undefined) throw new MissingHipNumberColumnError();

  const hips: NormalizedHip[] = [];
  const sessionDates = new Map<string, Date>();
  const warnings: string[] = [];

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
    const fields = parseCsvLine(lines[rowIndex]);
    const rowNumber = rowIndex + 1; // 1-based, incluyendo el header, como lo vería alguien mirando el CSV en Excel.
    const get = (logical: string): string | undefined => {
      const idx = columnIndex.get(logical);
      if (idx === undefined || idx >= fields.length) return undefined;
      const value = fields[idx].trim();
      return value.length > 0 ? value : undefined;
    };

    const hipNumber = fields[hipNumberIdx]?.trim();
    if (!hipNumber) {
      warnings.push(`Fila ${rowNumber}: sin "Hip Number" — se descarta.`);
      continue;
    }

    const media: CatalogMediaItem[] = [];
    for (const idx of photoColumns) {
      const url = fields[idx]?.trim();
      if (url) media.push({ kind: "photo", url });
    }
    for (const idx of videoColumns) {
      const url = fields[idx]?.trim();
      if (url) media.push({ kind: "video", url, caption: headerRaw[idx] });
    }

    let foalYear: number | undefined;
    const foalYearRaw = get("foalYear");
    if (foalYearRaw) {
      const parsed = parseInt(foalYearRaw, 10);
      if (!isNaN(parsed) && parsed > 1900 && parsed < 2100) foalYear = parsed;
      else warnings.push(`Fila ${rowNumber} (Hip ${hipNumber}): "Foal Year" = "${foalYearRaw}" no es un año válido — se ignora.`);
    }

    const sessionDateRaw = get("sessionDate");
    if (sessionDateRaw) {
      const parsed = new Date(`${sessionDateRaw}T12:00:00Z`);
      if (!isNaN(parsed.getTime())) sessionDates.set(hipNumber, parsed);
      else warnings.push(`Fila ${rowNumber} (Hip ${hipNumber}): "Session Date" = "${sessionDateRaw}" no se pudo interpretar como fecha — se ignora.`);
    }

    const priceRaw = get("price");
    const purchaser = get("purchaser");
    const soldAsCode = get("soldAsCode");
    const saleResult: SaleResultData | undefined =
      priceRaw || purchaser || soldAsCode ? { priceRaw, purchaser, soldAsCode } : undefined;

    hips.push({
      hipNumber,
      horseName: get("horseName"),
      sex: get("sex"),
      consignor: get("consignor"),
      sire: get("sire"),
      dam: get("dam"),
      damSire: get("damSire"),
      breeder: get("breeder"),
      foalYear,
      color: get("color"),
      media,
      saleResult,
    });
  }

  if (hips.length === 0) throw new EmptyManualCatalogError();

  return { hips, sessionDates, warnings };
}

export class SaleNotFoundError extends Error {
  constructor(saleId: string) {
    super(`No existe ninguna venta con id "${saleId}".`);
    this.name = "SaleNotFoundError";
  }
}

export interface ManualCatalogImportOutcome {
  catalogImport: CatalogImport;
  summary: UpsertSummary;
  warnings: string[];
  /** catalogAccess de la venta DESPUÉS del import — ver upgrade automático más abajo. */
  catalogAccess: string;
}

/**
 * Importa un catálogo completo a partir de un CSV ya subido (ver
 * POST /api/v1/sales/:saleId/catalog/import, api/routes.ts). Deja auditoría
 * en CatalogImport y actualiza Sale.lastCatalogCheckAt — así una venta
 * MANUAL_CSV se ve, para cualquier efecto de "hace cuánto se actualizó este
 * catálogo", exactamente igual que una FULL recién sincronizada.
 *
 * A diferencia de syncCatalog (que refina Sale.startDate con la sesión más
 * próxima), este import NO toca Sale.startDate si el CSV no trae ninguna
 * "Session Date" por fila — evita que un import parcial (ej. solo
 * actualizando fotos, sin columna de fecha) borre una fecha ya buena.
 *
 * Upgrade automático de catalogAccess: una venta que llegó a PENDING_ID o
 * UNAVAILABLE (sin ID real / sin ningún método de acceso) y recibe un CSV
 * con al menos un Hip válido demostró tener, en la práctica, un camino de
 * catálogo funcionando — se sube a MANUAL_CSV para que el scheduler
 * (processSale) empiece a analizarla/rankearla en el próximo ciclo, sin
 * ningún paso manual adicional. Una venta que ya era FULL NUNCA se
 * degrada por esto — un import manual puede coexistir con la sincronización
 * en vivo (ej. para corregir/enriquecer un dato puntual) sin cambiar cómo
 * se sigue sincronizando el resto de su catálogo.
 */
export async function importManualCatalog(
  saleId: string,
  csvText: string,
  meta: { fileName?: string; importedByUserId?: string }
): Promise<ManualCatalogImportOutcome> {
  const sale = await db.sale.findUnique({ where: { id: saleId }, select: { startDate: true, catalogAccess: true } });
  if (!sale) throw new SaleNotFoundError(saleId);

  const { hips, sessionDates, warnings } = parseManualCatalogCsv(csvText);

  const summary = await upsertNormalizedHips(saleId, hips, sessionDates);

  if (sessionDates.size > 0) {
    const earliestSessionDate = [...sessionDates.values()].sort((a, b) => a.getTime() - b.getTime())[0];
    if (earliestSessionDate && earliestSessionDate.getTime() !== sale.startDate?.getTime()) {
      await db.sale.update({ where: { id: saleId }, data: { startDate: earliestSessionDate } });
    }
  }

  const shouldUpgradeAccess = sale.catalogAccess === "PENDING_ID" || sale.catalogAccess === "UNAVAILABLE";
  const updatedSale = await db.sale.update({
    where: { id: saleId },
    data: {
      lastCatalogCheckAt: new Date(),
      ...(shouldUpgradeAccess ? { catalogAccess: "MANUAL_CSV" } : {}),
    },
    select: { catalogAccess: true },
  });

  const catalogImport = await db.catalogImport.create({
    data: {
      saleId,
      importedByUserId: meta.importedByUserId,
      fileName: meta.fileName,
      rowCount: hips.length,
      hipsCreated: summary.created,
      hipsUpdated: summary.updated,
      warningsJson: warnings as unknown as object,
    },
  });

  return { catalogImport, summary, warnings, catalogAccess: updatedSale.catalogAccess };
}
