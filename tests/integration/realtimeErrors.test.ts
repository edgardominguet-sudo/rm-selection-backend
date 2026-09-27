// WebSocket de sincronización en tiempo real (2026-09-26): si la base de
// datos falla al validar una conexión, se cierra ESA conexión con código
// de error de servidor y el proceso sigue — las siguientes conexiones
// funcionan normal.
import http from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { attachRealtime } from "../../src/realtime";
import { db } from "../../src/db";
import { createTestOrgAndUser, cleanupTestData } from "./fixtures";

jest.setTimeout(30000);

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end("ok"));
  attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => jest.restoreAllMocks());

function connect(apiKey: string): Promise<{ opened: boolean; closeCode: number | null; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(apiKey)}`);
    let opened = false;
    const timer = setTimeout(() => resolve({ opened, closeCode: null, ws }), 1500);
    ws.on("open", () => { opened = true; });
    ws.on("close", (code) => { clearTimeout(timer); resolve({ opened, closeCode: code, ws }); });
    ws.on("error", () => undefined);
  });
}

test("base de datos falla al validar -> la conexión se cierra con 1011 y el servidor sigue aceptando conexiones", async () => {
  const ctx = await createTestOrgAndUser();
  try {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(db.user, "findUnique").mockRejectedValueOnce(new Error("base de datos sin responder"));
    const failed = await connect(ctx.apiKey);
    expect(failed.closeCode).toBe(1011);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[realtime]"), expect.anything());

    // Conexión siguiente, normal: abre y se mantiene abierta
    const ok = await connect(ctx.apiKey);
    expect(ok.opened).toBe(true);
    expect(ok.closeCode).toBeNull();
    ok.ws.close();

    // Clave inválida sigue rechazándose igual que antes (4001)
    const bad = await connect("clave-invalida");
    expect(bad.closeCode).toBe(4001);
  } finally {
    await cleanupTestData({ organizationId: ctx.organization.id });
  }
});
