// Search por venta (2026-09-27) de punta a punta contra Postgres real:
// selectores con los valores de UNA venta, filtros combinados (Sire, Dam,
// Grand Sire, Broodmare Sire, Date of Birth, Sex, Color, Consignor),
// aislamiento entre ventas, detalle de resultados y SOLO LECTURA.
import request from "supertest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, cleanupTestData } from "./fixtures";
import { db } from "../../src/db";

const app = buildTestApp();
jest.setTimeout(60000);

let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
let saleId: string;
let otherSaleId: string;
const tag = randomUUID().slice(0, 8);
const house = "OBS";
const externalSaleId = `obs-oct-${tag}`;
const otherExternalSaleId = `srch-h-${tag}`;
const upcomingDay = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
const pastDay = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
const SIRE_A = `Into Mischief ${tag}`;
const SIRE_B = `Gun Runner ${tag}`;
const GRANDSIRE_A = `Harlan's Holiday ${tag}`;

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
  return request(app).post("/api/v1/search").set("x-api-key", ctx.apiKey).send({ house, externalSaleId, ...body });
}
const hips = (res: request.Response) => res.body.results.map((r: { hipNumber: string }) => r.hipNumber);

/**
 * Fotografía de TODAS las filas de la base vinculadas a los datos de este
 * test (por saleId, hipId, organizationId o userId, en cualquier tabla que
 * tenga esas columnas): cantidad y último updatedAt. Acotada a estos datos
 * porque otros archivos de test escriben en paralelo en la misma base.
 */
async function snapshotDatabase() {
  const hipIds = (await db.hip.findMany({ where: { saleId: { in: [saleId, otherSaleId] } }, select: { id: true } })).map((h) => h.id);
  const scope: Record<string, string[]> = {
    saleId: [saleId, otherSaleId],
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
  const sale = await db.sale.create({
    data: { house: "OBS", name: `October Yearling ${tag}`, externalSaleId, startDate: upcomingDay, endDate: upcomingDay, catalogAccess: "FULL" },
  });
  const other = await db.sale.create({
    data: { house: "FASIG_TIPTON", name: `Search Historic ${tag}`, externalSaleId: otherExternalSaleId, startDate: pastDay, endDate: pastDay, catalogAccess: "FULL" },
  });
  saleId = sale.id;
  otherSaleId = other.id;

  // Padre de cada padrillo (Grand Sire) — solo SIRE_A tiene dato cargado.
  await db.$executeRawUnsafe(`INSERT INTO "Stallion" (id, name, "sireName", "updatedAt") VALUES ($1, $2, $3, now())`, `st-a-${tag}`, SIRE_A.toUpperCase(), GRANDSIRE_A);
  await db.$executeRawUnsafe(`INSERT INTO "Stallion" (id, name, "updatedAt") VALUES ($1, $2, now())`, `st-b-${tag}`, SIRE_B.toUpperCase());

  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  await addHip(saleId, "1", { sire: SIRE_A, dam: "Ice Maiden", damSire: "Tapit", consignor: "Vinery Sales, Agent XVI", consignorBase: "Vinery Sales", bredState: "KY", sex: "C", color: "B", foalingDate: d("2025-01-20") }, { score: 9.1 }, "Comprar");
  await addHip(saleId, "2", { sire: SIRE_A.toUpperCase(), dam: "Racing Stripes", damSire: "TAPIT", consignor: "VINERY SALES, AGENT", bredState: "FL", sex: "F", color: "Chestnut", foalingDate: d("2025-03-05") });
  await addHip(saleId, "10", { sire: SIRE_B, dam: "Queen Caroline", damSire: "Medaglia d'Oro", consignor: "Hidden Brook, Agent II", bredState: "KY", sex: "C", color: "Dark Bay or Brown", foalingDate: d("2025-04-30"), saleResultJson: { priceRaw: "0.00", purchaser: "OUT", soldAsCode: "Y" } }, { score: 7.2 });
  await addHip(saleId, "3", { sire: SIRE_B, dam: "Sea View", damSire: null, consignor: "Hidden Brook Agent V", sex: "G", color: "GR/RO", foalingDate: null });
  // Otra venta: nunca debe aparecer ni en los selectores ni en los resultados.
  await addHip(otherSaleId, "1", { sire: SIRE_A, dam: "Other Dam", consignor: "Vinery Sales", sex: "C", color: "Bay", foalingDate: d("2025-02-01") });
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "Stallion" WHERE id IN ($1, $2)`, `st-a-${tag}`, `st-b-${tag}`);
  await cleanupTestData({ saleId });
  await cleanupTestData({ saleId: otherSaleId, organizationId: ctx.organization.id });
});

describe("Search por venta (base real)", () => {
  test("selectores: solo los valores de ESTA venta, agrupados sin distinguir mayúsculas", async () => {
    const res = await request(app).get(`/api/v1/search/filters?house=${house}&externalSaleId=${externalSaleId}`).set("x-api-key", ctx.apiKey).expect(200);
    const f = res.body;
    expect(f.sale).toMatchObject({ id: saleId, house: "OBS", status: "UPCOMING", hipCount: 4 });
    expect(f.sires).toEqual([
      { value: SIRE_B, count: 2 },
      { value: SIRE_A, count: 2 },
    ]);
    expect(f.dams.map((v: { value: string }) => v.value)).toEqual(["Ice Maiden", "Queen Caroline", "Racing Stripes", "Sea View"]);
    expect(f.dams.find((v: { value: string }) => v.value === "Other Dam")).toBeUndefined();
    expect(f.broodmareSires).toEqual([
      { value: "Medaglia d'Oro", count: 1 },
      { value: "Tapit", count: 2 },
    ]);
    expect(f.consignors).toEqual([
      { value: "Hidden Brook", count: 2 },
      { value: "Vinery Sales", count: 2 },
    ]);
    expect(f.grandsires).toEqual([{ value: GRANDSIRE_A, count: 2 }]);
    expect(f.sexes.map((v: { value: string }) => v.value).sort()).toEqual(["C", "F", "G"]);
    expect(f.colors).toEqual([
      { value: "Bay", count: 1 },
      { value: "Dark Bay/Brown", count: 1 },
      { value: "Chestnut", count: 1 },
      { value: "Gray/Roan", count: 1 },
    ]);
    expect(f.dateOfBirth).toEqual({ min: "2025-01-20", max: "2025-04-30", withData: 3 });
    // Estado de nacimiento: solo los que la fuente publicó (el HIP 3 no tiene).
    expect(f.bredStates).toEqual([
      { value: "KY", count: 2 },
      { value: "FL", count: 1 },
    ]);
  });

  test("Consignor: el rol de agente (Agent, Agent II, Agent V, AGENT) NO crea consignors separados", async () => {
    const res = await request(app).get(`/api/v1/search/filters?house=${house}&externalSaleId=${externalSaleId}`).set("x-api-key", ctx.apiKey).expect(200);
    // Una sola entrada por consignor real, con TODOS sus HIPs contados.
    expect(res.body.consignors).toEqual([
      { value: "Hidden Brook", count: 2 },
      { value: "Vinery Sales", count: 2 },
    ]);
    // Al elegirlo aparecen todos sus HIPs, cada uno una sola vez.
    expect(hips(await search({ consignors: ["Vinery Sales"] }))).toEqual(["1", "2"]);
    expect(hips(await search({ consignors: ["Hidden Brook"] }))).toEqual(["3", "10"]);
    // El texto original completo del consignor se conserva tal cual.
    const r = await search({ consignors: ["Vinery Sales"] });
    expect(r.body.results.map((i: { consignor: string }) => i.consignor)).toEqual(["Vinery Sales, Agent XVI", "VINERY SALES, AGENT"]);
  });

  test("Bred State: filtro y dato de cada HIP (sin dato -> null, nunca inventado)", async () => {
    expect(hips(await search({ bredStates: ["KY"] }))).toEqual(["1", "10"]);
    const all = await search({});
    const byHip = Object.fromEntries(all.body.results.map((i: { hipNumber: string; bredState: string | null }) => [i.hipNumber, i.bredState]));
    expect(byHip).toEqual({ "1": "KY", "2": "FL", "3": null, "10": "KY" });
    const bad = await search({ bredStates: ["Kentucky"] });
    expect(bad.status).toBe(400);
  });

  test("venta inexistente -> 404; faltan parámetros -> 400", async () => {
    await request(app).get(`/api/v1/search/filters?house=OBS&externalSaleId=nope-${tag}`).set("x-api-key", ctx.apiKey).expect(404);
    await request(app).get(`/api/v1/search/filters?house=OBS`).set("x-api-key", ctx.apiKey).expect(400);
  });

  test("sin filtros: toda la venta, en orden de HIP numérico, sin mezclar otras ventas", async () => {
    const res = await search({});
    expect(res.status).toBe(200);
    expect(hips(res)).toEqual(["1", "2", "3", "10"]);
    expect(res.body.total).toBe(4);
  });

  test("Sire (sin distinguir mayúsculas) y Broodmare Sire", async () => {
    expect(hips(await search({ sires: [SIRE_A] }))).toEqual(["1", "2"]);
    expect(hips(await search({ broodmareSires: ["tapit"] }))).toEqual(["1", "2"]);
  });

  test("Grand Sire: a través del padre del Sire (Stallion.sireName)", async () => {
    expect(hips(await search({ grandsires: [GRANDSIRE_A] }))).toEqual(["1", "2"]);
    expect(hips(await search({ grandsires: [`Nadie ${tag}`] }))).toEqual([]);
  });

  test("Dam, Consignor, Sex y Color", async () => {
    expect(hips(await search({ dams: ["Queen Caroline"] }))).toEqual(["10"]);
    expect(hips(await search({ consignors: ["hidden brook"] }))).toEqual(["3", "10"]);
    expect(hips(await search({ sexes: ["C"] }))).toEqual(["1", "10"]);
    expect(hips(await search({ colors: ["Dark Bay/Brown", "Gray/Roan"] }))).toEqual(["3", "10"]);
  });

  test("Date of Birth desde/hasta (incluye ambos extremos; sin fecha nunca entra)", async () => {
    expect(hips(await search({ dobFrom: "2025-01-20", dobTo: "2025-03-05" }))).toEqual(["1", "2"]);
    expect(hips(await search({ dobFrom: "2025-03-01" }))).toEqual(["2", "10"]);
    expect(hips(await search({ dobTo: "2025-01-19" }))).toEqual([]);
  });

  test("filtros combinados (AND)", async () => {
    expect(hips(await search({ sires: [SIRE_A, SIRE_B], sexes: ["C"], consignors: ["Vinery Sales"] }))).toEqual(["1"]);
  });

  test("detalle de cada resultado: venta, AI Score o 'Not analyzed', favorito, resultado", async () => {
    const res = await search({});
    const byHip = Object.fromEntries(res.body.results.map((r: { hipNumber: string }) => [r.hipNumber, r]));
    expect(byHip["1"]).toMatchObject({ aiScore: 9.1, aiClass: "EXCELENTE", isFavorite: true, favoriteDecision: "Comprar", color: "Bay", key: `OBS::${externalSaleId}::1` });
    expect(byHip["2"]).toMatchObject({ aiScore: null, aiClass: "NOT_ANALYZED", isFavorite: false });
    expect(byHip["10"].saleResult).toMatchObject({ status: "OUT", price: null });
    expect(byHip["1"].sale).toMatchObject({ house: "OBS", externalSaleId, status: "UPCOMING" });
  });

  test("paginación", async () => {
    const p1 = await search({ pageSize: 3 });
    const p2 = await search({ pageSize: 3, page: 2 });
    expect(hips(p1)).toEqual(["1", "2", "3"]);
    expect(hips(p2)).toEqual(["10"]);
    expect(p1.body.totalPages).toBe(2);
  });

  test("pedido inválido -> 400 con mensaje", async () => {
    const res = await search({ sexes: ["X"] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SEARCH");
  });

  test("refresco manual de Media en una venta FINALIZADA: no consulta la casa de ventas ni escribe nada", async () => {
    await addHip(otherSaleId, "7", { sex: "C", color: "Bay" });
    const before = await snapshotDatabase();
    const res = await request(app)
      .post("/api/v1/sales/hips/media-refresh")
      .set("x-api-key", ctx.apiKey)
      .send({ house: "FASIG_TIPTON", externalSaleId: otherExternalSaleId, hipNumber: "7" })
      .expect(200);
    expect(res.body).toMatchObject({ ok: false, reason: "sale_completed" });
    expect(await snapshotDatabase()).toEqual(before);
  });

  test("buscar es SOLO LECTURA: ninguna tabla de la base cambia", async () => {
    const before = await snapshotDatabase();
    await request(app).get(`/api/v1/search/filters?house=${house}&externalSaleId=${externalSaleId}`).set("x-api-key", ctx.apiKey).expect(200);
    await search({ sires: [SIRE_A], grandsires: [GRANDSIRE_A], dobFrom: "2025-01-01" });
    await search({ colors: ["Bay"], page: 2 });
    expect(await snapshotDatabase()).toEqual(before);
  });
});
