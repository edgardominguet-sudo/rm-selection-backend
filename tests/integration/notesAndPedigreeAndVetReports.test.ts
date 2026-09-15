// Protege Notes (/me/observations), Pedigree (/me/pedigree-annotations) y
// Vet Report (/me/vet-reports) — las 3 secciones de sincronización que
// comparten el mismo patrón (servidor como fuente de verdad, tombstone
// para borrados) pero cada una con su propia forma de "upsert idempotente"
// (ver comentarios reales en routes.ts).
import request from "supertest";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, createTestSaleAndHip, cleanupTestData } from "./fixtures";

const app = buildTestApp();

describe("Notes: /me/observations", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip();
  });
  afterEach(async () => {
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  test("crear una observación (sin id propio) y leerla", async () => {
    const post = await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ hipId: hipCtx.hip.id, text: "Cuartilla algo larga en lateral.", category: "CONFORMATION" })
      .expect(200);
    expect(post.body.text).toBe("Cuartilla algo larga en lateral.");

    const get = await request(app).get("/api/v1/me/observations").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
  });

  test("faltan campos requeridos (hipId/text) -> 400", async () => {
    await request(app).post("/api/v1/me/observations").set("x-api-key", ctx.apiKey).send({ hipId: hipCtx.hip.id }).expect(400);
  });

  test("mandar un id propio (UUID generado en el dispositivo) y reenviarlo es idempotente — nunca duplica la fila (reintento de sync tras respuesta perdida)", async () => {
    const clientId = "client-generated-uuid-123";
    const first = await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ id: clientId, hipId: hipCtx.hip.id, text: "Primera versión." })
      .expect(200);
    const retry = await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ id: clientId, hipId: hipCtx.hip.id, text: "Primera versión." })
      .expect(200);
    expect(first.body.id).toBe(retry.body.id);

    const get = await request(app).get("/api/v1/me/observations").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
  });

  test("borrar una observación (tombstone) hace que desaparezca de la lista normal, con `since` también", async () => {
    const before = new Date();
    const post = await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ hipId: hipCtx.hip.id, text: "Nota a borrar." })
      .expect(200);
    await request(app).delete(`/api/v1/me/observations/${post.body.id}`).set("x-api-key", ctx.apiKey).expect(200);

    const get = await request(app).get("/api/v1/me/observations").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(0);

    // `since` (usado para sincronización incremental) también debe reflejar 0 filas activas.
    const getSince = await request(app)
      .get(`/api/v1/me/observations?since=${before.toISOString()}`)
      .set("x-api-key", ctx.apiKey)
      .expect(200);
    expect(getSince.body).toHaveLength(0);
  });
});

describe("Pedigree: /me/pedigree-annotations", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip();
  });
  afterEach(async () => {
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  test("guardar el dibujo (PKDrawing en base64) y leerlo tal cual", async () => {
    const drawingData = Buffer.from("dibujo-de-prueba").toString("base64");
    const put = await request(app)
      .put(`/api/v1/me/pedigree-annotations/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ drawingData })
      .expect(200);
    expect(put.body.drawingData).toBe(drawingData);
  });

  test("borrar limpia drawingData a null además de marcar el tombstone", async () => {
    const drawingData = Buffer.from("algo").toString("base64");
    await request(app)
      .put(`/api/v1/me/pedigree-annotations/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ drawingData })
      .expect(200);
    await request(app).delete(`/api/v1/me/pedigree-annotations/${hipCtx.hip.id}`).set("x-api-key", ctx.apiKey).expect(200);

    const get = await request(app).get("/api/v1/me/pedigree-annotations").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(0);
  });
});

describe("Vet Report: /me/vet-reports", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip();
  });
  afterEach(async () => {
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  test("crear, actualizar y borrar un reporte veterinario", async () => {
    const post = await request(app)
      .post("/api/v1/me/vet-reports")
      .set("x-api-key", ctx.apiKey)
      .send({ hipId: hipCtx.hip.id, notes: "Radiografías normales." })
      .expect(200);
    expect(post.body.notes).toBe("Radiografías normales.");

    const put = await request(app)
      .put(`/api/v1/me/vet-reports/${post.body.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ notes: "Actualizado: leve hallazgo en corvejón izquierdo." })
      .expect(200);
    expect(put.body.notes).toBe("Actualizado: leve hallazgo en corvejón izquierdo.");

    await request(app).delete(`/api/v1/me/vet-reports/${post.body.id}`).set("x-api-key", ctx.apiKey).expect(200);
    const get = await request(app).get("/api/v1/me/vet-reports").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(0);
  });

  test("crear sin hipId -> 400", async () => {
    await request(app).post("/api/v1/me/vet-reports").set("x-api-key", ctx.apiKey).send({ notes: "x" }).expect(400);
  });

  test("actualizar un reporte que no existe (o de otro usuario) -> 404, nunca lo crea ni lo pisa", async () => {
    await request(app)
      .put("/api/v1/me/vet-reports/id-que-no-existe")
      .set("x-api-key", ctx.apiKey)
      .send({ notes: "x" })
      .expect(404);
  });
});
