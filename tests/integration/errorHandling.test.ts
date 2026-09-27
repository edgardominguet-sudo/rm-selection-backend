// Manejo de errores de la API de punta a punta contra una base real
// (2026-09-26). Antes de la corrección, cada uno de estos casos dejaba la
// petición sin respuesta y, en un proceso Node real, TUMBABA EL SERVIDOR.
// Ahora: respuesta HTTP controlada en el acto, ningún dato creado ni
// modificado, y el servidor sigue respondiendo normal.
import request from "supertest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, createTestSaleAndHip, cleanupTestData } from "./fixtures";
import { db } from "../../src/db";

const app = buildTestApp();
jest.setTimeout(30000);

/** Cantidad de filas de datos del usuario — para probar que una petición fallida no cambia nada. */
async function snapshotCounts(userId: string, saleId: string) {
  const [decisions, observations, pedigree, vet, hips] = await Promise.all([
    db.userDecision.count({ where: { userId } }),
    db.hipObservation.count({ where: { userId } }),
    db.pedigreeAnnotation.count({ where: { userId } }),
    db.vetReport.count({ where: { userId } }),
    db.hip.count({ where: { saleId } }),
  ]);
  return { decisions, observations, pedigree, vet, hips };
}

describe("Errores controlados de la API", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  const cases: Array<{ name: string; status: number; code: string; send: () => request.Test }> = [];
  const k = () => ctx.apiKey;
  cases.push(
    { name: "`since` con fecha inválida (Notas)", status: 400, code: "INVALID_SINCE", send: () => request(app).get("/api/v1/me/observations?since=no-es-fecha").set("x-api-key", k()) },
    { name: "`since` con fecha inválida (Favoritos)", status: 400, code: "INVALID_SINCE", send: () => request(app).get("/api/v1/me/decisions?since=2026-99-99").set("x-api-key", k()) },
    { name: "`since` repetido (no es una sola fecha)", status: 400, code: "INVALID_SINCE", send: () => request(app).get("/api/v1/me/pedigree-annotations?since=a&since=b").set("x-api-key", k()) },
    { name: "Favorito sobre un Hip que no existe", status: 400, code: "INVALID_REFERENCE", send: () => request(app).put("/api/v1/me/decisions/hip-inexistente").set("x-api-key", k()).send({ finalCall: "Comprar" }) },
    { name: "Nota con un dispositivo no registrado", status: 400, code: "INVALID_REFERENCE", send: () => request(app).post("/api/v1/me/observations").set("x-api-key", k()).send({ hipId: hipCtx.hip.id, text: "x", deviceId: "no-registrado" }) },
    { name: "Nota sobre un Hip que no existe", status: 400, code: "INVALID_REFERENCE", send: () => request(app).post("/api/v1/me/observations").set("x-api-key", k()).send({ hipId: "hip-inexistente", text: "x" }) },
    { name: "Pedigree sobre un Hip que no existe", status: 400, code: "INVALID_REFERENCE", send: () => request(app).put("/api/v1/me/pedigree-annotations/hip-inexistente").set("x-api-key", k()).send({ drawingData: "QQ==" }) },
    { name: "JSON mal formado", status: 400, code: "INVALID_JSON", send: () => request(app).post("/api/v1/me/observations").set("x-api-key", k()).set("Content-Type", "application/json").send("{no es json") }
  );

  test.each(cases.map((c) => [c.name, c]))("%s -> respuesta controlada al instante, sin cambiar datos, y el servidor sigue respondiendo", async (_name, c) => {
    const before = await snapshotCounts(ctx.user.id, hipCtx.sale.id);
    const t0 = Date.now();
    const res = await c.send().timeout(3000);
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(c.status);
    expect(res.body).toMatchObject({ code: c.code });
    expect(typeof res.body.error).toBe("string");
    expect(elapsed).toBeLessThan(1000);

    expect(await snapshotCounts(ctx.user.id, hipCtx.sale.id)).toEqual(before);

    // Petición válida inmediatamente después
    const ok = await request(app).get("/api/v1/me/decisions").set("x-api-key", k()).timeout(3000);
    expect(ok.status).toBe(200);
  });

  test("`since` válido sigue funcionando igual (sincronización delta sin cambios)", async () => {
    await request(app).put(`/api/v1/me/decisions/${hipCtx.hip.id}`).set("x-api-key", k()).send({ finalCall: "Comprar" }).expect(200);
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await request(app).get(`/api/v1/me/decisions?since=${encodeURIComponent(since)}`).set("x-api-key", k()).expect(200);
    expect(res.body).toHaveLength(1);
    const all = await request(app).get("/api/v1/me/decisions").set("x-api-key", k()).expect(200);
    expect(all.body).toHaveLength(1);
  });

  test("Registro inexistente al actualizar -> 404 (no se crea nada)", async () => {
    const before = await snapshotCounts(ctx.user.id, hipCtx.sale.id);
    const res = await request(app).put(`/api/v1/me/vet-reports/${randomUUID()}`).set("x-api-key", k()).send({ notes: "x" }).timeout(3000);
    expect(res.status).toBe(404);
    expect(await snapshotCounts(ctx.user.id, hipCtx.sale.id)).toEqual(before);
  });

  test("Error inesperado dentro de una ruta -> 500 controlado, registrado en el log, y el servidor sigue", async () => {
    jest.spyOn(db.userDecision, "findMany").mockRejectedValueOnce(new Error("fallo inesperado simulado"));
    const res = await request(app).get("/api/v1/me/decisions").set("x-api-key", k()).timeout(3000);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(res.body.error).not.toContain("simulado"); // nunca expone el detalle interno
    expect(console.error).toHaveBeenCalled();
    const ok = await request(app).get("/api/v1/me/decisions").set("x-api-key", k()).timeout(3000);
    expect(ok.status).toBe(200);
  });

  test("Conflicto de base de datos -> 409", async () => {
    const conflict = Object.assign(new Error("Unique constraint failed"), { name: "PrismaClientKnownRequestError", code: "P2002" });
    jest.spyOn(db.hipObservation, "findMany").mockRejectedValueOnce(conflict);
    const res = await request(app).get("/api/v1/me/observations").set("x-api-key", k()).timeout(3000);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  test("Autenticación con la base de datos caída -> 503 controlado (antes tumbaba el servidor), y luego se recupera", async () => {
    const down = Object.assign(new Error("Can't reach database server"), { name: "PrismaClientInitializationError" });
    jest.spyOn(db.user, "findUnique").mockRejectedValueOnce(down);
    const res = await request(app).get("/api/v1/me/decisions").set("x-api-key", k()).timeout(3000);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("DATABASE_UNAVAILABLE");
    const ok = await request(app).get("/api/v1/me/decisions").set("x-api-key", k()).timeout(3000);
    expect(ok.status).toBe(200);
  });

  test("Sincronización normal sigue igual después de varios errores: crear, modificar y borrar una nota", async () => {
    await request(app).get("/api/v1/me/observations?since=mal").set("x-api-key", k()).expect(400);
    await request(app).put("/api/v1/me/decisions/no-existe").set("x-api-key", k()).send({ finalCall: "Comprar" }).expect(400);
    const id = randomUUID();
    await request(app).post("/api/v1/me/observations").set("x-api-key", k()).send({ id, hipId: hipCtx.hip.id, text: "a" }).expect(200);
    await request(app).post("/api/v1/me/observations").set("x-api-key", k()).send({ id, hipId: hipCtx.hip.id, text: "b" }).expect(200);
    await request(app).delete(`/api/v1/me/observations/${id}`).set("x-api-key", k()).expect(200);
    const all = await request(app).get("/api/v1/me/observations").set("x-api-key", k()).expect(200);
    expect(all.body).toHaveLength(1);
    expect(all.body[0]).toMatchObject({ id, text: "b" });
    expect(all.body[0].deletedAt).not.toBeNull();
  });
});
