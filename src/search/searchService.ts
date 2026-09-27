// Advanced Search — acceso a datos (2026-09-27). SOLO LECTURA: únicamente
// consultas SELECT sobre lo que ya está guardado (Hip, Sale, SaleDay,
// análisis IA vigente, decisiones del usuario). Nunca descarga catálogos,
// media ni pedigrees, nunca analiza, nunca escribe ni dispara ningún
// proceso — consultar una venta terminada no la "reactiva" de ninguna
// forma. Las reglas (validación, campos derivados, filtros, orden) viven
// en searchLogic.ts.
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { startOfCalendarDay } from "../util/easternCalendarDay";
import { getSaleLifecycleStatus } from "../activeSaleService";
import { resolveReadUrl } from "../storage/r2Client";
import {
  SearchRequest,
  SearchCandidate,
  hipKey,
  normalizeColor,
  birthYearOf,
  saleStatusOf,
  salePriceOf,
  aiScoreOf,
  aiClassOf,
  applyDerivedFilters,
  sortCandidates,
  paginate,
  CANONICAL_COLORS,
  UNAVAILABLE_FIELDS,
  SaleResultInput,
} from "./searchLogic";

const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_CHUNK = 5000;

function etDayStart(isoDay: string): Date {
  // Mediodía ET del día pedido -> inicio de ese día calendario ET.
  return startOfCalendarDay(new Date(`${isoDay}T16:00:00Z`));
}

function contains(value: string): Prisma.StringNullableFilter {
  return { contains: value, mode: "insensitive" };
}

function saleWhereFor(req: SearchRequest): Prisma.SaleWhereInput {
  const and: Prisma.SaleWhereInput[] = [];
  if (req.saleIds) and.push({ id: { in: req.saleIds } });
  if (req.houses) and.push({ house: { in: req.houses } });
  if (req.years) {
    and.push({
      OR: req.years.map((y) => ({ startDate: { gte: etDayStart(`${y}-01-01`), lt: etDayStart(`${y + 1}-01-01`) } })),
    });
  }
  return and.length ? { AND: and } : {};
}

async function buildHipWhere(req: SearchRequest, userId: string): Promise<Prisma.HipWhereInput | null> {
  const saleWhere = saleWhereFor(req);
  const and: Prisma.HipWhereInput[] = [{ sale: saleWhere }];

  if (req.q) {
    const q = req.q;
    const or: Prisma.HipWhereInput[] = [
      { sire: contains(q) },
      { dam: contains(q) },
      { horseName: contains(q) },
      { consignor: contains(q) },
    ];
    if (/^\d+$/.test(q)) or.unshift({ hipNumber: q });
    and.push({ OR: or });
  }
  if (req.sire) and.push({ sire: contains(req.sire) });
  if (req.dam) and.push({ dam: contains(req.dam) });
  if (req.damSire) and.push({ damSire: contains(req.damSire) });
  if (req.horseName) and.push({ horseName: contains(req.horseName) });
  if (req.consignor) and.push({ consignor: contains(req.consignor) });
  if (req.barn) and.push({ barn: contains(req.barn) });
  if (req.sexes) and.push({ sex: { in: req.sexes } });

  if (req.saleDateFrom || req.saleDateTo) {
    and.push({
      sessionDate: {
        ...(req.saleDateFrom ? { gte: etDayStart(req.saleDateFrom) } : {}),
        ...(req.saleDateTo ? { lt: new Date(etDayStart(req.saleDateTo).getTime() + DAY_MS) } : {}),
      },
    });
  }

  // Libro / Sesión: salen del Calendario de Ventas ya guardado (SaleDay)
  // -> jornadas (venta + día) cuyos Hips se buscan por sessionDate.
  if (req.books || req.sessions) {
    const days = await db.saleDay.findMany({
      where: {
        sale: saleWhere,
        ...(req.books ? { book: { in: req.books } } : {}),
        ...(req.sessions ? { sessionNumber: { in: req.sessions } } : {}),
      },
      select: { saleId: true, date: true },
    });
    if (days.length === 0) return null; // ninguna jornada cumple -> ningún resultado
    and.push({
      OR: days.map((d) => {
        const start = startOfCalendarDay(d.date);
        return { saleId: d.saleId, sessionDate: { gte: start, lt: new Date(start.getTime() + DAY_MS) } };
      }),
    });
  }

  if (req.favoritesOnly) and.push({ decisions: { some: { userId, deletedAt: null } } });
  return { AND: and };
}

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

/** Ejecuta una búsqueda (solo lectura) para el usuario/organización autenticados. */
export async function runSearch(ctx: { organizationId: string; userId: string }, req: SearchRequest): Promise<SearchResponse> {
  const empty: SearchResponse = { total: 0, page: req.page, pageSize: req.pageSize, totalPages: 0, results: [] };
  const where = await buildHipWhere(req, ctx.userId);
  if (!where) return empty;

  const rows = await db.hip.findMany({
    where,
    select: {
      id: true,
      hipNumber: true,
      saleId: true,
      sessionDate: true,
      color: true,
      foalingDate: true,
      foalYear: true,
      saleResultJson: true,
      sale: { select: { house: true, externalSaleId: true } },
      decisions: { where: { userId: ctx.userId, deletedAt: null }, select: { finalCall: true } },
    },
  });
  if (rows.length === 0) return empty;

  const analyses = await loadAnalyses(ctx.organizationId, rows.map((r) => r.id));
  const favoriteByHipId = new Map<string, string>();
  const candidates: SearchCandidate[] = rows.map((r) => {
    const result = r.saleResultJson as SaleResultInput | null;
    const aiScore = aiScoreOf(analysisInput(analyses.get(r.id)));
    if (r.decisions[0]) favoriteByHipId.set(r.id, r.decisions[0].finalCall);
    return {
      hipId: r.id,
      key: hipKey(r.sale.house, r.sale.externalSaleId, r.hipNumber),
      hipNumber: r.hipNumber,
      saleId: r.saleId,
      sessionDate: r.sessionDate,
      color: normalizeColor(r.color),
      birthYear: birthYearOf(r.foalingDate, r.foalYear),
      saleStatus: saleStatusOf(result),
      price: salePriceOf(result),
      aiScore,
      aiClass: aiClassOf(aiScore),
      isFavorite: r.decisions.length > 0,
    };
  });

  const filtered = sortCandidates(applyDerivedFilters(candidates, req), req.sort);
  const pageItems = paginate(filtered, req.page, req.pageSize);
  const totalPages = Math.ceil(filtered.length / req.pageSize);
  if (pageItems.length === 0) return { ...empty, total: filtered.length, totalPages };

  const pageIds = pageItems.map((c) => c.hipId);
  const [hips, pointers] = await Promise.all([
    db.hip.findMany({ where: { id: { in: pageIds } }, include: { sale: true } }),
    db.currentHipAnalysis.findMany({
      where: { organizationId: ctx.organizationId, hipId: { in: pageIds } },
      select: { hipId: true, analysisResult: { select: { viewSourceAssetIdsJson: true } } },
    }),
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

  const saleIds = [...new Set(hips.map((h) => h.saleId))];
  const saleDays = await db.saleDay.findMany({ where: { saleId: { in: saleIds } }, select: { saleId: true, date: true, book: true, sessionNumber: true } });
  const dayKey = (saleId: string, d: Date) => `${saleId}|${startOfCalendarDay(d).getTime()}`;
  const saleDayByKey = new Map(saleDays.map((d) => [dayKey(d.saleId, d.date), d]));

  const results: SearchResultItem[] = pageItems.map((c) => {
    const h = hipById.get(c.hipId)!;
    const result = (h.saleResultJson as SaleResultInput | null) ?? null;
    const assetId = lateralAssetByHip.get(h.id);
    const storageKey = assetId ? storageKeyByAsset.get(assetId) : undefined;
    const catalogPhoto = (Array.isArray(h.mediaJson) ? (h.mediaJson as Array<{ kind?: string; url?: string }>) : []).find((m) => m?.kind === "photo" && typeof m.url === "string");
    const saleDay = h.sessionDate ? saleDayByKey.get(dayKey(h.saleId, h.sessionDate)) : undefined;
    return {
      hipId: h.id,
      key: c.key,
      hipNumber: h.hipNumber,
      horseName: h.horseName,
      sex: h.sex,
      color: c.color,
      sire: h.sire,
      dam: h.dam,
      damSire: h.damSire,
      birthYear: c.birthYear,
      foalingDate: h.foalingDate,
      consignor: h.consignor,
      barn: h.barn,
      sale: {
        id: h.sale.id,
        name: h.sale.name,
        house: h.sale.house,
        externalSaleId: h.sale.externalSaleId,
        status: getSaleLifecycleStatus(h.sale),
        startDate: h.sale.startDate,
        endDate: h.sale.endDate,
      },
      sessionDate: h.sessionDate,
      book: saleDay?.book ?? null,
      sessionNumber: saleDay?.sessionNumber ?? null,
      saleResult: {
        status: c.saleStatus,
        priceRaw: result?.priceRaw ?? null,
        price: c.price,
        purchaser: result?.purchaser ?? null,
        soldAsCode: result?.soldAsCode ?? null,
      },
      aiScore: c.aiScore,
      aiClass: c.aiClass,
      isFavorite: c.isFavorite,
      favoriteDecision: favoriteByHipId.get(h.id) ?? null,
      photoUrl: storageKey ? resolveReadUrl(storageKey) : catalogPhoto?.url ?? null,
      photoSource: storageKey ? "AI_LATERAL" : catalogPhoto ? "CATALOG" : null,
    };
  });

  return { total: filtered.length, page: req.page, pageSize: req.pageSize, totalPages, results };
}

/** Opciones para armar los filtros (ventas con Hips guardados, libros/sesiones, sexos, colores, años). */
export async function getSearchOptions() {
  const sales = await db.sale.findMany({
    where: { hips: { some: {} } },
    select: {
      id: true, name: true, house: true, externalSaleId: true, startDate: true, endDate: true,
      _count: { select: { hips: true } },
      saleDays: { select: { date: true, book: true, sessionNumber: true }, orderBy: { date: "asc" } },
    },
    orderBy: { startDate: "desc" },
  });
  const [sexRows, colorRows, yearRows] = await Promise.all([
    db.hip.groupBy({ by: ["sex"], _count: { _all: true } }),
    db.hip.groupBy({ by: ["color"], _count: { _all: true } }),
    db.$queryRaw<Array<{ y: number }>>`SELECT DISTINCT COALESCE(EXTRACT(YEAR FROM "foalingDate")::int, "foalYear") AS y FROM "Hip" WHERE "foalingDate" IS NOT NULL OR "foalYear" IS NOT NULL ORDER BY y`,
  ]);
  const presentColors = new Set(colorRows.map((r) => normalizeColor(r.color)).filter((c): c is string => !!c));
  return {
    sales: sales.map((s) => ({
      id: s.id,
      name: s.name,
      house: s.house,
      externalSaleId: s.externalSaleId,
      startDate: s.startDate,
      endDate: s.endDate,
      year: s.startDate ? Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(s.startDate)) : null,
      status: getSaleLifecycleStatus(s),
      hipCount: s._count.hips,
      days: s.saleDays.map((d) => ({ date: d.date, book: d.book, sessionNumber: d.sessionNumber })),
    })),
    sexes: sexRows.filter((r) => r.sex).map((r) => ({ value: r.sex as string, count: r._count._all })).sort((a, b) => b.count - a.count),
    colors: CANONICAL_COLORS.filter((c) => presentColors.has(c)),
    birthYears: yearRows.map((r) => Number(r.y)).filter((y) => Number.isFinite(y)),
    unavailableFields: [...UNAVAILABLE_FIELDS],
  };
}

export const SUGGEST_FIELDS = ["sire", "dam", "damSire", "consignor", "horseName"] as const;
export type SuggestField = (typeof SUGGEST_FIELDS)[number];

/** Columna real de cada campo sugerible — lista cerrada (nunca se arma SQL con texto del cliente). */
const SUGGEST_COLUMN: Record<SuggestField, string> = {
  sire: '"sire"',
  dam: '"dam"',
  damSire: '"damSire"',
  consignor: '"consignor"',
  horseName: '"horseName"',
};

/** Sugerencias para autocompletar (valores reales guardados, ordenados por frecuencia). */
export async function suggestValues(field: SuggestField, q: string, saleIds?: string[]): Promise<string[]> {
  // La columna sale SIEMPRE de la lista cerrada de arriba; el texto buscado
  // y las ventas van como parámetros ($1, $2) — nunca concatenados.
  const column = SUGGEST_COLUMN[field];
  const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const bySale = saleIds && saleIds.length > 0;
  const sql =
    `SELECT ${column} AS v, count(*) AS n FROM "Hip" WHERE ${column} ILIKE $1` +
    (bySale ? ` AND "saleId" = ANY($2::text[])` : "") +
    ` GROUP BY ${column} ORDER BY n DESC, v ASC LIMIT 15`;
  const rows = bySale
    ? await db.$queryRawUnsafe<Array<{ v: string }>>(sql, pattern, saleIds)
    : await db.$queryRawUnsafe<Array<{ v: string }>>(sql, pattern);
  return rows.map((r) => r.v).filter((v) => typeof v === "string" && v.trim().length > 0);
}
