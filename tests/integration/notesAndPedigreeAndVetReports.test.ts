// Protege Notes (/me/observations), Pedigree (/me/pedigree-annotations) y
// Vet Report (/me/vet-reports) — las 3 secciones de sincronización que
// comparten el mismo patrón (servidor como fuente de verdad, tombstone
// para borrados) pero cada una con su propia forma de "upsert idempotente"
// (ver comentarios reales en routes.ts).
import request from "supertest";
import { randomUUID } from "node:crypto";
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

  // CORREGIDO 2026-09-26: este test esperaba una lista vacía después de
  // borrar, pero la sincronización necesita que el borrado VIAJE a los
  // otros dispositivos: el servidor devuelve la nota marcada como borrada
  // (tombstone, deletedAt) y cada dispositivo la quita localmente
  // (SyncEngine.pullObservations). También en la lista completa: la app la
  // pide sin `since` cuando reinicia su cursor, y ahí también tiene que
  // enterarse de lo borrado.
  test("borrar una observación (tombstone): llega MARCADA COMO BORRADA en la lista completa y en la de cambios, nunca como activa", async () => {
    const before = new Date();
    const post = await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ hipId: hipCtx.hip.id, text: "Nota a borrar." })
      .expect(200);
    await request(app).delete(`/api/v1/me/observations/${post.body.id}`).set("x-api-key", ctx.apiKey).expect(200);

    const get = await request(app).get("/api/v1/me/observations").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].id).toBe(post.body.id);
    expect(get.body[0].deletedAt).not.toBeNull();

    const getSince = await request(app)
      .get(`/api/v1/me/observations?since=${before.toISOString()}`)
      .set("x-api-key", ctx.apiKey)
      .expect(200);
    expect(getSince.body).toHaveLength(1);
    expect(getSince.body[0].id).toBe(post.body.id);
    expect(getSince.body[0].deletedAt).not.toBeNull();

    const active = (rows: Array<{ deletedAt: string | null }>) => rows.filter((r) => r.deletedAt === null);
    expect(active(get.body)).toHaveLength(0);
    expect(active(getSince.body)).toHaveLength(0);
  });

  // NUEVO 2026-09-26: una subida atrasada de una nota ya borrada (ej. un
  // reintento de sincronización que quedó en cola en otro dispositivo) no
  // puede revivirla — el upsert por id nunca limpia deletedAt (routes.ts).
  test("una subida/reenvío atrasado de una nota ya borrada NO la revive", async () => {
    const noteId = randomUUID();
    await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ id: noteId, hipId: hipCtx.hip.id, text: "Nota original." })
      .expect(200);
    await request(app).delete(`/api/v1/me/observations/${noteId}`).set("x-api-key", ctx.apiKey).expect(200);

    // Llega tarde el mismo POST (mismo id) que había quedado en cola.
    await request(app)
      .post("/api/v1/me/observations")
      .set("x-api-key", ctx.apiKey)
      .send({ id: noteId, hipId: hipCtx.hip.id, text: "Nota original." })
      .expect(200);

    const get = await request(app).get("/api/v1/me/observations").set("x-api-key", ctx.apiKey).expect(200);
    const rows = get.body.filter((r: { id: string }) => r.id === noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();
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
    const beforeDelete = new Date();
    await new Promise((r) => setTimeout(r, 15));
    await request(app).delete(`/api/v1/me/pedigree-annotations/${hipCtx.hip.id}`).set("x-api-key", ctx.apiKey).expect(200);

    // CORREGIDO 2026-09-26: el borrado tiene que llegar a los otros
    // dispositivos (SyncEngine.pullPedigreeAnnotations quita el dibujo
    // local) — llega MARCADO COMO BORRADO y SIN el dibujo, tanto en la
    // lista completa como en la de cambios.
    const get = await request(app).get("/api/v1/me/pedigree-annotations").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].hipId).toBe(hipCtx.hip.id);
    expect(get.body[0].deletedAt).not.toBeNull();
    expect(get.body[0].drawingData).toBeNull();

    const getSince = await request(app)
      .get(`/api/v1/me/pedigree-annotations?since=${beforeDelete.toISOString()}`)
      .set("x-api-key", ctx.apiKey)
      .expect(200);
    expect(getSince.body).toHaveLength(1);
    expect(getSince.body[0].deletedAt).not.toBeNull();
    expect(getSince.body[0].drawingData).toBeNull();
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

    const beforeDelete = new Date();
    await new Promise((r) => setTimeout(r, 15));
    await request(app).delete(`/api/v1/me/vet-reports/${post.body.id}`).set("x-api-key", ctx.apiKey).expect(200);

    // CORREGIDO 2026-09-26: igual que Notas/Decisiones/Pedigree, el
    // borrado llega MARCADO COMO BORRADO (tombstone) para que los otros
    // dispositivos se enteren — nunca como activo.
    const get = await request(app).get("/api/v1/me/vet-reports").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].id).toBe(post.body.id);
    expect(get.body[0].deletedAt).not.toBeNull();

    const getSince = await request(app)
      .get(`/api/v1/me/vet-reports?since=${beforeDelete.toISOString()}`)
      .set("x-api-key", ctx.apiKey)
      .expect(200);
    expect(getSince.body).toHaveLength(1);
    expect(getSince.body[0].deletedAt).not.toBeNull();
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
