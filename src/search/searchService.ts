// Search por venta (2026-09-27) — SOLO LECTURA. Ver searchLogic.ts.
//
// Dos operaciones, siempre acotadas a UNA venta (house + externalSaleId):
//   - getSaleSearchFilters: los valores que EXISTEN en esa venta para cada
//     selector (Sire, Dam, Grand Sire, Broodmare Sire, Consignor, Sex,
//     Color) y el rango real de fechas de nacimiento. Consultas agrupadas
//     en la base (GROUP BY), nunca se traen los Hips a memoria.
//   - runSaleSearch: aplica los filtros en SQL, ordena por HIP y arma el
//     detalle SOLO de la página pedida (foto, AI Score, favorito,
//     resultado de venta) — misma lógica de detalle que la versión anterior.
//
// Grand Sire: ni el catálogo de OBS ni el de otras casas lo publican. Se
// resuelve con `Stallion.sireName` (padre de cada padrillo, cargado aparte):
// Grand Sire de un Hip = sireName del Stallion cuyo nombre coincide con su
// Sire. Mientras esa columna no tenga datos, el selector vuelve vacío y la
// app lo muestra como "Not available" — nunca se infiere ni se inventa.
import { db } from "../db";
import { startOfCalendarDay } from "../util/easternCalendarDay";
import { getSaleLifecycleStatus } from "../activeSaleService";
import { resolveReadUrl } from "../storage/r2Client";
import { HttpError } from "../api/errorHandler";
import { AGENT_SUFFIX_SQL_PATTERN } from "../catalogNames";
import {
  SaleSearchRequest,
  CANONICAL_COLORS,
  hipKey,
  nameKey,
  normalizeColor,
  saleStatusOf,
  salePriceOf,
  aiScoreOf,
  aiClassOf,
  compareHips,
  paginate,
  SaleResultInput,
} from "./searchLogic";

const ANALYSIS_CHUNK = 500;

async function resolveSale(house: string, externalSaleId: string) {
  const sale = await db.sale.findFirst({ where: { house: house as never, externalSaleId } });
  if (!sale) throw new HttpError(404, `Venta ${house}/${externalSaleId} no encontrada.`, "SALE_NOT_FOUND");
  return sale;
}

// ---------------------------------------------------------------------------
// Opciones de los selectores
// ---------------------------------------------------------------------------

export interface FilterValue {
  value: string;
  count: number;
}

export interface SaleSearchFilters {
  sale: { id: string; name: string; house: string; externalSaleId: string; status: string; startDate: Date | null; endDate: Date | null; hipCount: number };
  sires: FilterValue[];
  dams: FilterValue[];
  grandsires: FilterValue[];
  broodmareSires: FilterValue[];
  consignors: FilterValue[];
  sexes: FilterValue[];
  colors: FilterValue[];
  bredStates: FilterValue[];
  dateOfBirth: { min: string | null; max: string | null; withData: number };
}

// Expresiones permitidas (lista cerrada — nunca texto del usuario en el SQL).
//
// Consignor (2026-09-28): se agrupa y se filtra por el NOMBRE REAL, sin el
// rol de agente ("Vinery Sales, Agent XVI" y "Vinery Sales, Agent" son el
// mismo consignor). Primero `consignorBase` (dato de la fuente, ver
// catalogNames.ts); para filas guardadas antes de esa columna, la misma
// regla aplicada en SQL. `consignor` (texto completo) no se modifica.
const CONSIGNOR_NAME_SQL = `COALESCE(NULLIF(btrim("consignorBase"), ''), NULLIF(btrim(regexp_replace(btrim("consignor"), '${AGENT_SUFFIX_SQL_PATTERN}', '', 'i')), ''))`;
const NAME_COLUMNS = { sire: `"sire"`, dam: `"dam"`, damSire: `"damSire"`, consignor: CONSIGNOR_NAME_SQL } as const;

async function groupedNames(saleId: string, column: string): Promise<FilterValue[]> {
  // Agrupa sin distinguir mayúsculas/espacios y muestra la variante escrita
  // en mixto si existe ("Into Mischief" antes que "INTO MISCHIEF").
  const rows = await db.$queryRawUnsafe<Array<{ v: string; n: number }>>(
    `SELECT (array_agg(btrim(${column}) ORDER BY (btrim(${column}) = upper(btrim(${column}))), btrim(${column})))[1] AS v,
            count(*)::int AS n
       FROM "Hip"
      WHERE "saleId" = $1 AND ${column} IS NOT NULL AND btrim(${column}) <> ''
      GROUP BY upper(btrim(${column}))
      ORDER BY upper(btrim(min(${column}))) ASC`,
    saleId
  );
  return rows.map((r) => ({ value: r.v, count: Number(r.n) }));
}

function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export async function getSaleSearchFilters(house: string, externalSaleId: string): Promise<SaleSearchFilters> {
  const sale = await resolveSale(house, externalSaleId);
  const [sires, dams, broodmareSires, consignors, sexRows, colorRows, grandsireRows, dobRows, stateRows] = await Promise.all([
    groupedNames(sale.id, NAME_COLUMNS.sire),
    groupedNames(sale.id, NAME_COLUMNS.dam),
    groupedNames(sale.id, NAME_COLUMNS.damSire),
    groupedNames(sale.id, NAME_COLUMNS.consignor),
    db.$queryRawUnsafe<Array<{ v: string; n: number }>>(
      `SELECT upper(btrim("sex")) AS v, count(*)::int AS n FROM "Hip"
        WHERE "saleId" = $1 AND "sex" IS NOT NULL AND btrim("sex") <> ''
        GROUP BY upper(btrim("sex")) ORDER BY 2 DESC`,
      sale.id
    ),
    db.$queryRawUnsafe<Array<{ v: string; n: number }>>(
      `SELECT "color" AS v, count(*)::int AS n FROM "Hip" WHERE "saleId" = $1 AND "color" IS NOT NULL GROUP BY "color"`,
      sale.id
    ),
    db.$queryRawUnsafe<Array<{ v: string; n: number }>>(
      `SELECT (array_agg(btrim(s."sireName") ORDER BY (btrim(s."sireName") = upper(btrim(s."sireName"))), btrim(s."sireName")))[1] AS v,
              count(h.id)::int AS n
         FROM "Hip" h
         JOIN "Stallion" s ON upper(btrim(s."name")) = upper(btrim(h."sire"))
        WHERE h."saleId" = $1 AND s."sireName" IS NOT NULL AND btrim(s."sireName") <> ''
        GROUP BY upper(btrim(s."sireName"))
        ORDER BY upper(btrim(min(s."sireName"))) ASC`,
      sale.id
    ),
    db.$queryRawUnsafe<Array<{ mn: Date | null; mx: Date | null; withData: number; total: number }>>(
      `SELECT min("foalingDate") AS mn, max("foalingDate") AS mx,
              count("foalingDate")::int AS "withData", count(*)::int AS total
         FROM "Hip" WHERE "saleId" = $1`,
      sale.id
    ),
    db.$queryRawUnsafe<Array<{ v: string; n: number }>>(
      `SELECT upper(btrim("bredState")) AS v, count(*)::int AS n FROM "Hip"
        WHERE "saleId" = $1 AND "bredState" IS NOT NULL AND btrim("bredState") <> ''
        GROUP BY upper(btrim("bredState")) ORDER BY 2 DESC, 1 ASC`,
      sale.id
    ),
  ]);

  // Colores: la fuente mezcla abreviaturas — se suman por color canónico.
  const colorCounts = new Map<string, number>();
  for (const r of colorRows) {
    const canonical = normalizeColor(r.v);
    if (canonical) colorCounts.set(canonical, (colorCounts.get(canonical) ?? 0) + Number(r.n));
  }
  const dob = dobRows[0];

  return {
    sale: {
      id: sale.id,
      name: sale.name,
      house: sale.house,
      externalSaleId: sale.externalSaleId,
      status: getSaleLifecycleStatus(sale),
      startDate: sale.startDate,
      endDate: sale.endDate,
      hipCount: Number(dob?.total ?? 0),
    },
    sires,
    dams,
    grandsires: grandsireRows.map((r) => ({ value: r.v, count: Number(r.n) })),
    broodmareSires,
    consignors,
    sexes: sexRows.map((r) => ({ value: r.v, count: Number(r.n) })),
    colors: CANONICAL_COLORS.filter((c) => colorCounts.has(c)).map((c) => ({ value: c, count: colorCounts.get(c)! })),
    dateOfBirth: { min: isoDay(dob?.mn ?? null), max: isoDay(dob?.mx ?? null), withData: Number(dob?.withData ?? 0) },
    bredStates: stateRows.map((r) => ({ value: r.v, count: Number(r.n) })),
  };
}

// ---------------------------------------------------------------------------
// Análisis IA de la página (reutilizado de la versión anterior)
// ---------------------------------------------------------------------------

type AnalysisRow = { hipId: string; source: string; cs: unknown; lat: string | null; fro: string | null; pos: string | null; overall: number };

async function loadAnalyses(organizationId: string, hipIds: string[]): Promise<Map<string, AnalysisRow>> {
  const map = new Map<string, AnalysisRow>();
  for (let i = 0; i < hipIds.length; i += ANALYSIS_CHUNK) {
    const ids = hipIds.slice(i, i + ANALYSIS_CHUNK);
    // Solo las banderas de disponibilidad por vista, nunca el JSON completo
    // de landmarks (pesado) — la búsqueda se mantiene liviana.
    const rows = await db.$queryRaw<AnalysisRow[]>`
      SELECT c."hipId", a.source::text AS source, a."conformationScoresJson" AS cs,
             a."landmarksJson"->'lateral'->>'available' AS lat,
             a."landmarksJson"->'frontal'->>'available' AS fro,
             a."landmarksJson"->'posterior'->>'available' AS pos,
             a."overallScore" AS overall
      FROM "CurrentHipAnalysis" c
      JOIN "AnalysisResult" a ON a.id = c."analysisResultId"
      WHERE c."organizationId" = ${organizationId} AND c."hipId" = ANY(${ids}::text[])`;
    for (const r of rows) map.set(r.hipId, r);
  }
  return map;
}

function analysisInput(row: AnalysisRow | undefined) {
  if (!row) return null;
  return {
    source: row.source,
    overallScore: Number(row.overall),
    conformationScoresJson: row.cs,
    landmarksJson: {
      lateral: { available: row.lat === "true" },
      frontal: { available: row.fro === "true" },
      posterior: { available: row.pos === "true" },
    },
  };
}

export interface SearchResultItem {
  hipId: string;
  key: string;
  hipNumber: string;
  horseName: string | null;
  sex: string | null;
  color: string | null;
  sire: string | null;
  dam: string | null;
  damSire: string | null;
  birthYear: number | null;
  foalingDate: Date | null;
  consignor: string | null;
  /** Estado/país donde nació ("KY"...) — null si la fuente no lo publica. */
  bredState: string | null;
  barn: string | null;
  sale: { id: string; name: string; house: string; externalSaleId: string; status: string; startDate: Date | null; endDate: Date | null };
  sessionDate: Date | null;
  book: string | null;
  sessionNumber: number | null;
  saleResult: { status: string; priceRaw: string | null; price: number | null; purchaser: string | null; soldAsCode: string | null };
  aiScore: number | null;
  aiClass: string;
  isFavorite: boolean;
  favoriteDecision: string | null;
  photoUrl: string | null;
  photoSource: "AI_LATERAL" | "CATALOG" | null;
}

export interface SearchResponse {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  results: SearchResultItem[];
}

/** Busca dentro de UNA venta (solo lectura) para el usuario/organización autenticados. */
export async function runSaleSearch(ctx: { organizationId: string; userId: string }, req: SaleSearchRequest): Promise<SearchResponse> {
  const sale = await resolveSale(req.house, req.externalSaleId);
  const empty: SearchResponse = { total: 0, page: req.page, pageSize: req.pageSize, totalPages: 0, results: [] };
  const keys = (list?: string[]) => (list && list.length ? list.map(nameKey) : null);

  // Todos los filtros de nombre comparan por clave normalizada
  // (upper + espacios), igual que se agruparon las opciones.
  const rows = await db.$queryRawUnsafe<Array<{ id: string; hipNumber: string; color: string | null }>>(
    `SELECT h.id, h."hipNumber", h."color"
       FROM "Hip" h
      WHERE h."saleId" = $1
        AND ($2::text[] IS NULL OR upper(regexp_replace(btrim(h."sire"), '\\s+', ' ', 'g')) = ANY($2::text[]))
        AND ($3::text[] IS NULL OR upper(regexp_replace(btrim(h."dam"), '\\s+', ' ', 'g')) = ANY($3::text[]))
        AND ($4::text[] IS NULL OR upper(regexp_replace(btrim(h."damSire"), '\\s+', ' ', 'g')) = ANY($4::text[]))
        AND ($5::text[] IS NULL OR upper(regexp_replace(${CONSIGNOR_NAME_SQL.replace(/"consignor(Base)?"/g, (m) => `h.${m}`)}, '\\s+', ' ', 'g')) = ANY($5::text[]))
        AND ($10::text[] IS NULL OR upper(btrim(h."bredState")) = ANY($10::text[]))
        AND ($6::text[] IS NULL OR upper(btrim(h."sex")) = ANY($6::text[]))
        AND ($7::text[] IS NULL OR upper(btrim(h."sire")) IN (
              SELECT upper(btrim(s."name")) FROM "Stallion" s
               WHERE upper(regexp_replace(btrim(s."sireName"), '\\s+', ' ', 'g')) = ANY($7::text[])))
        AND ($8::date IS NULL OR h."foalingDate" >= $8::date)
        AND ($9::date IS NULL OR h."foalingDate" < ($9::date + 1))`,
    sale.id,
    keys(req.sires),
    keys(req.dams),
    keys(req.broodmareSires),
    keys(req.consignors),
    req.sexes ? req.sexes.map((s) => s.toUpperCase()) : null,
    keys(req.grandsires),
    req.dobFrom ?? null,
    req.dobTo ?? null,
    req.bredStates ?? null
  );

  const colorSet = req.colors ? new Set(req.colors) : null;
  const matching = rows
    .filter((r) => !colorSet || colorSet.has(normalizeColor(r.color) ?? ""))
    .sort((a, b) => compareHips(a.hipNumber, b.hipNumber) || (a.id < b.id ? -1 : 1));
  if (matching.length === 0) return empty;

  const totalPages = Math.ceil(matching.length / req.pageSize);
  const pageRows = paginate(matching, req.page, req.pageSize);
  if (pageRows.length === 0) return { ...empty, total: matching.length, totalPages };

  // Detalle SOLO de la página pedida.
  const pageIds = pageRows.map((r) => r.id);
  const [hips, pointers, analyses] = await Promise.all([
    db.hip.findMany({
      where: { id: { in: pageIds } },
      include: { decisions: { where: { userId: ctx.userId, deletedAt: null }, select: { finalCall: true } } },
    }),
    db.currentHipAnalysis.findMany({
      where: { organizationId: ctx.organizationId, hipId: { in: pageIds } },
      select: { hipId: true, analysisResult: { select: { viewSourceAssetIdsJson: true } } },
    }),
    loadAnalyses(ctx.organizationId, pageIds),
  ]);
  const hipById = new Map(hips.map((h) => [h.id, h]));

  // Foto lateral del análisis IA (si existe) -> si no, la foto del catálogo ya guardada.
  const lateralAssetByHip = new Map<string, string>();
  for (const p of pointers) {
    const lateral = (p.analysisResult.viewSourceAssetIdsJson as { lateral?: string } | null)?.lateral;
    if (lateral) lateralAssetByHip.set(p.hipId, lateral);
  }
  const assets = lateralAssetByHip.size
    ? await db.mediaAsset.findMany({ where: { id: { in: [...lateralAssetByHip.values()] }, deletedAt: null }, select: { id: true, storageKey: true } })
    : [];
  const storageKeyByAsset = new Map(assets.map((a) => [a.id, a.storageKey]));

  const saleDays = await db.saleDay.findMany({ where: { saleId: sale.id }, select: { date: true, book: true, sessionNumber: true } });
  const saleDayByTime = new Map(saleDays.map((d) => [startOfCalendarDay(d.date).getTime(), d]));
  const saleInfo = {
    id: sale.id,
    name: sale.name,
    house: sale.house,
    externalSaleId: sale.externalSaleId,
    status: getSaleLifecycleStatus(sale),
    startDate: sale.startDate,
    endDate: sale.endDate,
  };

  const results: SearchResultItem[] = pageRows.map((row) => {
    const h = hipById.get(row.id)!;
    const result = (h.saleResultJson as SaleResultInput | null) ?? null;
    const aiScore = aiScoreOf(analysisInput(analyses.get(h.id)));
    const assetId = lateralAssetByHip.get(h.id);
    const storageKey = assetId ? storageKeyByAsset.get(assetId) : undefined;
    const catalogPhoto = (Array.isArray(h.mediaJson) ? (h.mediaJson as Array<{ kind?: string; url?: string }>) : []).find(
      (m) => m?.kind === "photo" && typeof m.url === "string"
    );
    const saleDay = h.sessionDate ? saleDayByTime.get(startOfCalendarDay(h.sessionDate).getTime()) : undefined;
    const decision = h.decisions[0]?.finalCall ?? null;
    return {
      hipId: h.id,
      key: hipKey(sale.house, sale.externalSaleId, h.hipNumber),
      hipNumber: h.hipNumber,
      horseName: h.horseName,
      sex: h.sex,
      color: normalizeColor(h.color),
      sire: h.sire,
      dam: h.dam,
      damSire: h.damSire,
      birthYear: h.foalingDate ? h.foalingDate.getUTCFullYear() : h.foalYear ?? null,
      foalingDate: h.foalingDate,
      consignor: h.consignor,
      bredState: h.bredState ?? null,
      barn: h.barn,
      sale: saleInfo,
      sessionDate: h.sessionDate,
      book: saleDay?.book ?? null,
      sessionNumber: saleDay?.sessionNumber ?? null,
      saleResult: {
        status: saleStatusOf(result),
        priceRaw: result?.priceRaw ?? null,
        price: salePriceOf(result),
        purchaser: result?.purchaser ?? null,
        soldAsCode: result?.soldAsCode ?? null,
      },
      aiScore,
      aiClass: aiClassOf(aiScore),
      isFavorite: decision !== null,
      favoriteDecision: decision,
      photoUrl: storageKey ? resolveReadUrl(storageKey) : catalogPhoto?.url ?? null,
      photoSource: storageKey ? "AI_LATERAL" : catalogPhoto ? "CATALOG" : null,
    };
  });

  return { total: matching.length, page: req.page, pageSize: req.pageSize, totalPages, results };
}
