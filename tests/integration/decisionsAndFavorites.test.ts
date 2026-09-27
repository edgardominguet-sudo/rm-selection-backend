// Protege /me/decisions — la "Decisión" final (Comprar/Revisar/Descartar)
// de cada Hip, y la base de datos de la que "Mis Favoritos" lee su lista
// (un Hip con decisión guardada). Server-as-source-of-truth con
// upsert+tombstone: estos tests fijan exactamente ese contrato para que
// un dispositivo offline siga viendo lo mismo que los demás al reconectar.
import request from "supertest";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, createTestSaleAndHip, cleanupTestData } from "./fixtures";

const app = buildTestApp();

describe("PUT/GET/DELETE /me/decisions/:hipId", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip();
  });

  afterEach(async () => {
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  test("sin API key -> 401", async () => {
    await request(app).put(`/api/v1/me/decisions/${hipCtx.hip.id}`).send({ finalCall: "Comprar" }).expect(401);
  });

  test("guardar una decisión y volver a leerla", async () => {
    const put = await request(app)
      .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ finalCall: "Comprar", notes: "Buen aplomo, comprar.", deviceId: ctx.device.id })
      .expect(200);
    expect(put.body.finalCall).toBe("Comprar");
    expect(put.body.notes).toBe("Buen aplomo, comprar.");

    const get = await request(app).get("/api/v1/me/decisions").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].finalCall).toBe("Comprar");
    expect(get.body[0].hipId).toBe(hipCtx.hip.id);
  });

  test("guardar 2 veces la misma decisión hace upsert (nunca duplica filas) — mismo criterio de Favoritos: 1 fila por Hip", async () => {
    await request(app)
      .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ finalCall: "Revisar" })
      .expect(200);
    await request(app)
      .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ finalCall: "Comprar" })
      .expect(200);

    const get = await request(app).get("/api/v1/me/decisions").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].finalCall).toBe("Comprar"); // el valor más reciente gana
  });

  test("falta finalCall -> 400, no crea nada", async () => {
    await request(app).put(`/api/v1/me/decisions/${hipCtx.hip.id}`).set("x-api-key", ctx.apiKey).send({}).expect(400);
    const get = await request(app).get("/api/v1/me/decisions").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(0);
  });

  // CORREGIDO 2026-09-26: este test esperaba una lista vacía después de
  // borrar, pero la sincronización necesita que el borrado VIAJE a los
  // otros dispositivos: el servidor devuelve la fila marcada como borrada
  // (tombstone, deletedAt) y cada dispositivo la quita localmente
  // (SyncEngine.pullDecisions). Si no llegara, el otro dispositivo seguiría
  // mostrando la decisión para siempre.
  test("borrar una decisión es un tombstone (deletedAt), no un borrado físico — llega MARCADA COMO BORRADA en la lista completa y en la de cambios", async () => {
    await request(app)
      .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ finalCall: "Comprar" })
      .expect(200);
    const beforeDelete = new Date();
    await new Promise((r) => setTimeout(r, 15));
    await request(app).delete(`/api/v1/me/decisions/${hipCtx.hip.id}`).set("x-api-key", ctx.apiKey).expect(200);

    // Lista completa (sin `since`): la fila sigue, pero marcada como borrada.
    const get = await request(app).get("/api/v1/me/decisions").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].hipId).toBe(hipCtx.hip.id);
    expect(get.body[0].deletedAt).not.toBeNull();

    // Consulta de cambios (`since`): el borrado es un cambio y tiene que llegar.
    const getSince = await request(app)
      .get(`/api/v1/me/decisions?since=${beforeDelete.toISOString()}`)
      .set("x-api-key", ctx.apiKey)
      .expect(200);
    expect(getSince.body).toHaveLength(1);
    expect(getSince.body[0].deletedAt).not.toBeNull();

    // Nunca vuelve como activa: ninguna fila activa para este Hip.
    expect(get.body.filter((d: { deletedAt: string | null }) => d.deletedAt === null)).toHaveLength(0);
  });

  test("re-guardar una decisión después de borrarla la revive (deletedAt vuelve a null)", async () => {
    await request(app)
      .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ finalCall: "Comprar" })
      .expect(200);
    await request(app).delete(`/api/v1/me/decisions/${hipCtx.hip.id}`).set("x-api-key", ctx.apiKey).expect(200);
    await request(app)
      .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
      .set("x-api-key", ctx.apiKey)
      .send({ finalCall: "Descartar" })
      .expect(200);

    const get = await request(app).get("/api/v1/me/decisions").set("x-api-key", ctx.apiKey).expect(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0].finalCall).toBe("Descartar");
  });

  test("aislamiento por usuario: la decisión de un usuario nunca aparece en la lista de otro", async () => {
    const other = await createTestOrgAndUser();
    try {
      await request(app)
        .put(`/api/v1/me/decisions/${hipCtx.hip.id}`)
        .set("x-api-key", ctx.apiKey)
        .send({ finalCall: "Comprar" })
        .expect(200);

      const otherGet = await request(app).get("/api/v1/me/decisions").set("x-api-key", other.apiKey).expect(200);
      expect(otherGet.body).toHaveLength(0);
    } finally {
      await cleanupTestData({ organizationId: other.organization.id });
    }
  });
});
