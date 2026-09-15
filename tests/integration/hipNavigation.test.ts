// Protege /hips/resolve — la ruta que usa la navegación Hip-a-Hip (saltar
// a otro número de Hip desde HipNumberEntryView) para traducir
// (casa, venta, número de Hip) al `hipId` interno. Si esto se rompe, el
// usuario escribe un número de Hip válido y la app dice "no encontrado" en
// medio de una venta en vivo.
import request from "supertest";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, createTestSaleAndHip, cleanupTestData } from "./fixtures";

const app = buildTestApp();

describe("GET /hips/resolve", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip({ hipNumber: "82" });
  });
  afterEach(async () => {
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  test("resuelve un Hip real por (house, externalSaleId, hipNumber)", async () => {
    const res = await request(app)
      .get("/api/v1/hips/resolve")
      .query({ house: hipCtx.sale.house, externalSaleId: hipCtx.sale.externalSaleId, hipNumber: "82" })
      .set("x-api-key", ctx.apiKey)
      .expect(200);
    expect(res.body.hipId).toBe(hipCtx.hip.id);
  });

  test("un Hip inexistente en una venta real da 404, no un error genérico ni un id inventado", async () => {
    const res = await request(app)
      .get("/api/v1/hips/resolve")
      .query({ house: hipCtx.sale.house, externalSaleId: hipCtx.sale.externalSaleId, hipNumber: "999999" })
      .set("x-api-key", ctx.apiKey)
      .expect(404);
    expect(res.body.hipId).toBeUndefined();
  });

  test("faltan parámetros -> 400", async () => {
    await request(app).get("/api/v1/hips/resolve").query({ house: "KEENELAND" }).set("x-api-key", ctx.apiKey).expect(400);
  });

  test("sin API key -> 401", async () => {
    await request(app)
      .get("/api/v1/hips/resolve")
      .query({ house: hipCtx.sale.house, externalSaleId: hipCtx.sale.externalSaleId, hipNumber: "82" })
      .expect(401);
  });
});
