// Advanced Search de punta a punta contra una base Postgres real
// (2026-09-27): venta activa + venta histórica, HIP analizados y sin
// analizar, favoritos, libros/sesiones, resultados de venta. Verifica
// también que buscar es SOLO LECTURA: ninguna tabla cambia.
import request from "supertest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, cleanupTestData } from "./fixtures";
import { db } from "../../src/db";

const app = buildTestApp();
jest.setTimeout(60000);

let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
let activeSaleId: string;
let historicalSaleId: string;
const tag = randomUUID().slice(0, 8); // aísla los datos de este test

const now = Date.now();
const activeDay = new Date(now + 2 * 60 * 60 * 1000);
const pastDay = new Date(now - 400 * 24 * 60 * 60 * 1000);

async function addHip(saleId: string, hipNumber: string, data: Record<string, unknown>, analysis?: { score: number; source?: "AI" | "MANUAL"; lateral?: boolean }, favorite?: string) {
  const hip = await db.hip.create({
    data: { saleId, hipNumber, sire: `Sire${tag}`, dam: `Dam ${hipNumber}`, consignor: `Consignor${tag}`, ...data },
  });
  if (analysis) {
    const s = analysis.score;
    const result = await db.analysisResult.create({
      data: {
        hipId: hip.id,
        organizationId: ctx.organization.id,
        source: analysis.source ?? "AI",
        conformationScoresJson: { "lateral.proportions": s, "lateral.topline": s, "lateral.structure": s },
        overallScore: s,
        classification: "Revisar",
        landmarksJson: { lateral: { available: analysis.lateral ?? true } },
        model: "test",
      },
    });
    await db.currentHipAnalysis.create({ data: { hipId: hip.id, organizationId: ctx.organization.id, analysisResultId: result.id } });
  }
  if (favorite) {
    await db.userDecision.create({ data: { userId: ctx.user.id, organizationId: ctx.organization.id, hipId: hip.id, finalCall: favorite } });
  }
  return hip;
}

async function search(body: object) {
  const res = await request(app).post("/api/v1/search").set("x-api-key", ctx.apiKey).send({ saleIds: [activeSaleId, historicalSaleId], ...body });
  return res;
}
const hips = (res: request.Response) => res.body.results.map((r: { hipNumber: string }) => r.hipNumber);

/**
 * Fotografía de TODAS las filas de la base vinculadas a los datos de este
 * test (por saleId, hipId, organizationId o userId, en cualquier tabla que
 * tenga esas columnas): cantidad y último updatedAt. Acotada a estos datos
 * porque otros archivos de test escriben en paralelo en la misma base.
 */
async function snapshotDatabase() {
  const hipIds = (await db.hip.findMany({ where: { saleId: { in: [activeSaleId, historicalSaleId] } }, select: { id: true } })).map((h) => h.id);
  const scope: Record<string, string[]> = {
    saleId: [activeSaleId, historicalSaleId],
    hipId: hipIds,
    organizationId: [ctx.organization.id],
    userId: [ctx.user.id],
  };
  const cols = await db.$queryRaw<Array<{ t: string; c: string }>>`
    SELECT table_name::text AS t, column_name::text AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('saleId','hipId','organizationId','userId') ORDER BY 1, 2`;
  const snap: Record<string, string> = {};
  for (const { t, c } of cols) {
    const hasUpdatedAt = (await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=${t} AND column_name='updatedAt'`)[0].n > 0n;
    const select = hasUpdatedAt ? `count(*)::text || '|' || coalesce(max("updatedAt")::text,'')` : `count(*)::text`;
    const [{ v }] = await db.$queryRawUnsafe<Array<{ v: string }>>(`SELECT ${select} AS v FROM "${t}" WHERE "${c}" = ANY($1::text[])`, scope[c]);
    snap[`${t}.${c}`] = v;
  }
  // Las propias filas de las ventas y de la organización.
  snap.sales = JSON.stringify(await db.sale.findMany({ where: { id: { in: scope.saleId } }, orderBy: { id: "asc" } }));
  return snap;
}

beforeAll(async () => {
  ctx = await createTestOrgAndUser();
  const active = await db.sale.create({
    data: { house: "KEENELAND", name: `Search Active ${tag}`, externalSaleId: `srch-a-${tag}`, startDate: activeDay, endDate: activeDay, catalogAccess: "FULL" },
  });
  const historical = await db.sale.create({
    data: { house: "FASIG_TIPTON", name: `Search Historic ${tag}`, externalSaleId: `srch-h-${tag}`, startDate: pastDay, endDate: pastDay, catalogAccess: "FULL" },
  });
  activeSaleId = active.id;
  historicalSaleId = historical.id;
  await db.saleDay.create({ data: { saleId: activeSaleId, date: activeDay, book: "1", sessionNumber: 1, source: "test" } });

  // Venta activa
  await addHip(activeSaleId, "101", { sex: "C", color: "B", sessionDate: activeDay, horseName: "Colt Excelente" }, { score: 9.2 }, "Comprar");
  await addHip(activeSaleId, "102", { sex: "F", color: "Chestnut", sessionDate: activeDay, saleResultJson: { priceRaw: "250000.00", purchaser: "Buyer X" } }, { score: 7.8 });
  await addHip(activeSaleId, "103", { sex: "C", color: "Dark Bay or Brown", sessionDate: activeDay, saleResultJson: { purchaser: "R.N.A. (19,000)", soldAsCode: "RNA" } });
  await addHip(activeSaleId, "104", { sex: "C", color: "DB/BR", sessionDate: activeDay }, { score: 9.9, source: "MANUAL" });
  await addHip(activeSaleId, "105", { sex: "C", color: "B", sessionDate: activeDay, sire: `OtherSire${tag}` }, { score: 8.7 }, "Revisar");
  // Venta histórica
  await addHip(historicalSaleId, "7", { sex: "C", color: "Bay", sessionDate: pastDay, saleResultJson: { priceRaw: "400000.00", purchaser: "Old Buyer" }, foalingDate: new Date("2024-02-01T00:00:00Z") }, { score: 8.8 });
  await addHip(historicalSaleId, "8", { sex: "F", color: "GR/RO", sessionDate: pastDay, saleResultJson: { soldAsCode: "OUT" } });
});

afterAll(async () => {
  await cleanupTestData({ saleId: activeSaleId });
  await cleanupTestData({ saleId: historicalSaleId, organizationId: ctx.organization.id });
});

describe("Advanced Search (base real)", () => {
  test("Quick Search por HIP", async () => {
    const res = await search({ q: "103" });
    expect(res.status).toBe(200);
    expect(hips(res)).toEqual(["103"]);
  });

  test("Quick Search por Sire (no distingue mayúsculas)", async () => {
    const res = await search({ q: `othersire${tag}` });
    expect(hips(res)).toEqual(["105"]);
  });

  test("múltiples filtros combinados: Keeneland + año + Colt + Sire + AI Score ≥ 8.5 + Mis Favoritos", async () => {
    const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(activeDay));
    const res = await search({ houses: ["KEENELAND"], years: [year], sexes: ["C"], sire: `Sire${tag}`, aiScoreMin: 8.5, favoritesOnly: true });
    expect(hips(res)).toEqual(["101", "105"]);
  });

  test("búsqueda dentro de la venta activa y dentro de una venta histórica", async () => {
    const active = await search({ saleIds: [activeSaleId] });
    expect(hips(active)).toEqual(["101", "102", "103", "104", "105"]);
    expect(active.body.results[0].sale.status).not.toBe("COMPLETED");
    const historic = await search({ saleIds: [historicalSaleId] });
    expect(hips(historic)).toEqual(["7", "8"]);
    expect(historic.body.results[0].sale.status).toBe("COMPLETED");
    expect(historic.body.results[0].birthYear).toBe(2024);
  });

  test("HIP sin análisis IA -> 'Not analyzed' (sin score); puntaje manual o lateral no evaluada tampoco cuentan", async () => {
    const res = await search({ saleIds: [activeSaleId], q: "10" });
    const byHip = Object.fromEntries(res.body.results.map((r: { hipNumber: string }) => [r.hipNumber, r]));
    expect(byHip["103"]).toMatchObject({ aiScore: null, aiClass: "NOT_ANALYZED" });
    expect(byHip["104"]).toMatchObject({ aiScore: null, aiClass: "NOT_ANALYZED" });
    expect(byHip["101"]).toMatchObject({ aiScore: 9.2, aiClass: "EXCELENTE" });
    expect(byHip["102"]).toMatchObject({ aiScore: 7.8, aiClass: "BIEN" });
  });

  test("resultados: favorito, venta, fecha, consignor, resultado de venta y color normalizado", async () => {
    const res = await search({ q: "101" });
    const r = res.body.results[0];
    expect(r).toMatchObject({ isFavorite: true, favoriteDecision: "Comprar", consignor: `Consignor${tag}`, color: "Bay", book: "1", sessionNumber: 1, key: `KEENELAND::srch-a-${tag}::101` });
    expect(new Date(r.sessionDate).getTime()).toBe(activeDay.getTime());
    const rna = (await search({ q: "103" })).body.results[0];
    expect(rna.saleResult).toMatchObject({ status: "RNA", price: null });
    const sold = (await search({ q: "102" })).body.results[0];
    expect(sold.saleResult).toMatchObject({ status: "SOLD", price: 250000 });
  });

  test("ordenamiento por HIP (asc/desc), por AI Score y por Precio", async () => {
    expect(hips(await search({ sort: { field: "HIP", direction: "ASC" } }))).toEqual(["7", "8", "101", "102", "103", "104", "105"]);
    expect(hips(await search({ sort: { field: "HIP", direction: "DESC" } }))).toEqual(["105", "104", "103", "102", "101", "8", "7"]);
    const byScore = hips(await search({ sort: { field: "AI_SCORE", direction: "DESC" } }));
    expect(byScore.slice(0, 4)).toEqual(["101", "7", "105", "102"]);
    expect(hips(await search({ sort: { field: "PRICE", direction: "DESC" } })).slice(0, 2)).toEqual(["7", "102"]);
  });

  test("filtros de venta: RNA, vendido con rango de precio, OUT", async () => {
    expect(hips(await search({ saleStatuses: ["RNA"] }))).toEqual(["103"]);
    expect(hips(await search({ saleStatuses: ["SOLD"], priceMin: 300000 }))).toEqual(["7"]);
    expect(hips(await search({ saleStatuses: ["OUT"] }))).toEqual(["8"]);
  });

  test("libro y sesión (Calendario de Ventas guardado)", async () => {
    expect(hips(await search({ books: ["1"] }))).toEqual(["101", "102", "103", "104", "105"]);
    expect(hips(await search({ sessions: [2] }))).toEqual([]);
  });

  test("color normalizado y clases IA", async () => {
    expect(hips(await search({ colors: ["Dark Bay/Brown"] }))).toEqual(["103", "104"]);
    expect(hips(await search({ aiClasses: ["EXCELENTE"] }))).toEqual(["7", "101", "105"]);
    expect(hips(await search({ aiClasses: ["NOT_ANALYZED"] }))).toEqual(["8", "103", "104"]);
  });

  test("Revisado ✓ / No revisado con las claves del dispositivo", async () => {
    const keys = [`KEENELAND::srch-a-${tag}::102`, `FASIG_TIPTON::srch-h-${tag}::7`];
    expect(hips(await search({ reviewed: "REVIEWED", reviewedKeys: keys }))).toEqual(["7", "102"]);
    expect(hips(await search({ reviewed: "NOT_REVIEWED", reviewedKeys: keys }))).toEqual(["8", "101", "103", "104", "105"]);
  });

  test("paginación: total y páginas correctos, sin cargar todo de una vez", async () => {
    const p1 = await search({ pageSize: 3, page: 1 });
    const p3 = await search({ pageSize: 3, page: 3 });
    expect(p1.body).toMatchObject({ total: 7, totalPages: 3, page: 1 });
    expect(hips(p1)).toHaveLength(3);
    expect(hips(p3)).toEqual(["105"]);
  });

  test("pedido inválido -> 400 controlado", async () => {
    const res = await search({ aiScoreMin: 20 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SEARCH");
  });

  test("opciones de filtros: ventas con su estado, libros/sesiones y campos no disponibles", async () => {
    const res = await request(app).get("/api/v1/search/options").set("x-api-key", ctx.apiKey).expect(200);
    const historic = res.body.sales.find((s: { id: string }) => s.id === historicalSaleId);
    const active = res.body.sales.find((s: { id: string }) => s.id === activeSaleId);
    expect(historic).toMatchObject({ status: "COMPLETED", hipCount: 2 });
    expect(active.days).toEqual([expect.objectContaining({ book: "1", sessionNumber: 1 })]);
    expect(res.body.unavailableFields).toEqual(expect.arrayContaining(["grandsire", "stateFoaled", "breedersCupEligible"]));
    expect(res.body.colors).toEqual(expect.arrayContaining(["Bay", "Chestnut"]));
  });

  test("sugerencias de Sire (valores reales guardados)", async () => {
    const res = await request(app).get(`/api/v1/search/suggest?field=sire&q=othersire${tag}`).set("x-api-key", ctx.apiKey).expect(200);
    expect(res.body.values).toEqual([`OtherSire${tag}`]);
  });

  test("buscar (incluida la venta histórica) es SOLO LECTURA: ninguna tabla de la base cambia", async () => {
    const before = await snapshotDatabase();
    await search({ saleIds: [historicalSaleId] });
    await search({ q: "7", sort: { field: "AI_SCORE", direction: "DESC" } });
    await search({ houses: ["FASIG_TIPTON"], favoritesOnly: true });
    await request(app).get("/api/v1/search/options").set("x-api-key", ctx.apiKey).expect(200);
    await request(app).get(`/api/v1/search/suggest?field=dam&q=Dam`).set("x-api-key", ctx.apiKey).expect(200);
    const after = await snapshotDatabase();
    expect(after).toEqual(before);
  });
});
