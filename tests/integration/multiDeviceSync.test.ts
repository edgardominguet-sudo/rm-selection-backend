// Sincronización iPhone <-> iPad de punta a punta (2026-09-26): creación,
// modificación y eliminación de Notas, Decisiones (Favoritos) y Pedigree.
//
// Cada "dispositivo" de este test hace exactamente lo que hace
// SyncEngine.swift en la app: sube sus cambios, pide al servidor "qué
// cambió desde mi cursor" (`since` = updatedAt de la última fila aplicada),
// aplica cada fila en su copia local — si viene marcada como borrada
// (deletedAt) la QUITA — y avanza su cursor. El test solo usa las rutas
// reales del servidor; no cambia ninguna.
import request from "supertest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "./testApp";
import { createTestOrgAndUser, createTestSaleAndHip, cleanupTestData } from "./fixtures";
import { db } from "../../src/db";

const app = buildTestApp();
const tick = () => new Promise((r) => setTimeout(r, 15));

type Row = { id?: string; hipId: string; updatedAt: string; deletedAt: string | null; [k: string]: unknown };

/** Copia local de un dispositivo para una familia de datos, con su propio cursor de sincronización. */
class DeviceStore {
  items = new Map<string, Row>();
  private cursor: string | null = null;
  constructor(private readonly path: string, private readonly keyOf: (r: Row) => string) {}

  async pull(apiKey: string) {
    const url = this.cursor ? `${this.path}?since=${encodeURIComponent(this.cursor)}` : this.path;
    const res = await request(app).get(url).set("x-api-key", apiKey).expect(200);
    for (const row of res.body as Row[]) {
      if (row.deletedAt) this.items.delete(this.keyOf(row));
      else this.items.set(this.keyOf(row), row);
      if (!this.cursor || row.updatedAt > this.cursor) this.cursor = row.updatedAt;
    }
    return res.body as Row[];
  }

  /** Simula el reinicio de cursor que hace la app en ciertas migraciones: vuelve a pedir la lista completa. */
  resetCursor() {
    this.cursor = null;
  }
}

jest.setTimeout(30000);

describe("Sincronización iPhone <-> iPad", () => {
  let ctx: Awaited<ReturnType<typeof createTestOrgAndUser>>;
  let hipCtx: Awaited<ReturnType<typeof createTestSaleAndHip>>;
  // Dos dispositivos REGISTRADOS del mismo usuario (como en la app: el
  // deviceId que manda cada cambio es el de un Device real).
  let IPAD: string;
  let IPHONE: string;

  beforeEach(async () => {
    ctx = await createTestOrgAndUser();
    hipCtx = await createTestSaleAndHip();
    IPAD = ctx.device.id;
    IPHONE = (await db.device.create({ data: { userId: ctx.user.id, platform: "ios", deviceName: "Test iPhone 2" } })).id;
  });
  afterEach(async () => {
    await cleanupTestData({ organizationId: ctx.organization.id, saleId: hipCtx.sale.id });
  });

  test("Notas: crear en iPad, modificar en iPhone, borrar en iPad — ambos quedan iguales y la nota borrada no reaparece", async () => {
    const ipad = new DeviceStore("/api/v1/me/observations", (r) => r.id!);
    const iphone = new DeviceStore("/api/v1/me/observations", (r) => r.id!);
    const noteId = randomUUID();

    // Crear en iPad
    await request(app).post("/api/v1/me/observations").set("x-api-key", ctx.apiKey)
      .send({ id: noteId, hipId: hipCtx.hip.id, text: "Buen movimiento.", deviceId: IPAD }).expect(200);
    await iphone.pull(ctx.apiKey);
    expect(iphone.items.get(noteId)?.text).toBe("Buen movimiento.");

    // Modificar en iPhone
    await tick();
    await request(app).post("/api/v1/me/observations").set("x-api-key", ctx.apiKey)
      .send({ id: noteId, hipId: hipCtx.hip.id, text: "Buen movimiento, algo toed-out.", deviceId: IPHONE }).expect(200);
    await ipad.pull(ctx.apiKey);
    expect(ipad.items.get(noteId)?.text).toBe("Buen movimiento, algo toed-out.");

    // Borrar en iPad
    await tick();
    await request(app).delete(`/api/v1/me/observations/${noteId}`).set("x-api-key", ctx.apiKey).expect(200);
    await ipad.pull(ctx.apiKey);
    await iphone.pull(ctx.apiKey);
    expect(ipad.items.has(noteId)).toBe(false);
    expect(iphone.items.has(noteId)).toBe(false);

    // No reaparece: ni en sincronizaciones posteriores, ni con el cursor
    // reiniciado (lista completa), ni después de una subida atrasada.
    await request(app).post("/api/v1/me/observations").set("x-api-key", ctx.apiKey)
      .send({ id: noteId, hipId: hipCtx.hip.id, text: "Buen movimiento.", deviceId: IPHONE }).expect(200);
    await iphone.pull(ctx.apiKey);
    iphone.resetCursor();
    await iphone.pull(ctx.apiKey);
    await ipad.pull(ctx.apiKey);
    expect(iphone.items.has(noteId)).toBe(false);
    expect(ipad.items.has(noteId)).toBe(false);
  });

  test("Decisiones (Favoritos): crear en iPhone, cambiar en iPad, borrar en iPhone — ambos quedan iguales", async () => {
    const ipad = new DeviceStore("/api/v1/me/decisions", (r) => r.hipId);
    const iphone = new DeviceStore("/api/v1/me/decisions", (r) => r.hipId);
    const hipId = hipCtx.hip.id;

    await request(app).put(`/api/v1/me/decisions/${hipId}`).set("x-api-key", ctx.apiKey).send({ finalCall: "Revisar", deviceId: IPHONE }).expect(200);
    await ipad.pull(ctx.apiKey);
    expect(ipad.items.get(hipId)?.finalCall).toBe("Revisar");

    await tick();
    await request(app).put(`/api/v1/me/decisions/${hipId}`).set("x-api-key", ctx.apiKey).send({ finalCall: "Comprar", deviceId: IPAD }).expect(200);
    await iphone.pull(ctx.apiKey);
    expect(iphone.items.get(hipId)?.finalCall).toBe("Comprar");

    await tick();
    await request(app).delete(`/api/v1/me/decisions/${hipId}`).set("x-api-key", ctx.apiKey).expect(200);
    await ipad.pull(ctx.apiKey);
    await iphone.pull(ctx.apiKey);
    expect(ipad.items.has(hipId)).toBe(false);
    expect(iphone.items.has(hipId)).toBe(false);

    ipad.resetCursor();
    await ipad.pull(ctx.apiKey);
    expect(ipad.items.has(hipId)).toBe(false);
  });

  test("Pedigree: dibujar en iPad, redibujar en iPhone, borrar en iPad — el dibujo desaparece en ambos", async () => {
    const ipad = new DeviceStore("/api/v1/me/pedigree-annotations", (r) => r.hipId);
    const iphone = new DeviceStore("/api/v1/me/pedigree-annotations", (r) => r.hipId);
    const hipId = hipCtx.hip.id;
    const v1 = Buffer.from("trazo-1").toString("base64");
    const v2 = Buffer.from("trazo-1+trazo-2").toString("base64");

    await request(app).put(`/api/v1/me/pedigree-annotations/${hipId}`).set("x-api-key", ctx.apiKey).send({ drawingData: v1, deviceId: IPAD }).expect(200);
    await iphone.pull(ctx.apiKey);
    expect(iphone.items.get(hipId)?.drawingData).toBe(v1);

    await tick();
    await request(app).put(`/api/v1/me/pedigree-annotations/${hipId}`).set("x-api-key", ctx.apiKey).send({ drawingData: v2, deviceId: IPHONE }).expect(200);
    await ipad.pull(ctx.apiKey);
    expect(ipad.items.get(hipId)?.drawingData).toBe(v2);

    await tick();
    await request(app).delete(`/api/v1/me/pedigree-annotations/${hipId}`).set("x-api-key", ctx.apiKey).expect(200);
    const rows = await iphone.pull(ctx.apiKey);
    await ipad.pull(ctx.apiKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();
    expect(rows[0].drawingData).toBeNull();
    expect(iphone.items.has(hipId)).toBe(false);
    expect(ipad.items.has(hipId)).toBe(false);
  });
});
