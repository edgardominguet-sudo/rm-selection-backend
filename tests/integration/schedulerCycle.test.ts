// Ciclo automático de 5 minutos (2026-09-26): si falla, el estado "en
// curso" se libera SIEMPRE — antes, un fallo en su primera consulta lo
// dejaba trabado para siempre y el ciclo no volvía a correr.
import { db } from "../../src/db";
import { runCycle } from "../../src/scheduler";
import * as activeSaleService from "../../src/activeSaleService";

jest.setTimeout(30000);

beforeEach(() => {
  // Sin venta activa: el ciclo no sale a internet ni toca ventas de otros tests.
  jest.spyOn(activeSaleService, "resolveActiveSaleForAutomation").mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

test("un fallo al registrar el inicio del ciclo no deja el ciclo trabado", async () => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(db.schedulerRun, "create").mockRejectedValueOnce(new Error("base de datos sin responder"));

  await expect(runCycle()).resolves.toBeUndefined(); // nunca propaga el error
  const before = await db.schedulerRun.count();
  await runCycle(); // si "en curso" hubiera quedado trabado, este ciclo se saltaría
  expect(await db.schedulerRun.count()).toBe(before + 1);
  expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("todavía está corriendo"));
});

test("un fallo a mitad del ciclo se registra en el SchedulerRun y el ciclo se libera", async () => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(db.organization, "findMany").mockRejectedValueOnce(new Error("fallo a mitad de ciclo"));
  await runCycle();
  const last = await db.schedulerRun.findFirst({ orderBy: { startedAt: "desc" } });
  expect(last?.finishedAt).not.toBeNull();
  expect(last?.errorMessage).toContain("fallo a mitad de ciclo");
  const count = await db.schedulerRun.count();
  await runCycle();
  expect(await db.schedulerRun.count()).toBe(count + 1);
});

test("un fallo al registrar el cierre del ciclo también libera el estado", async () => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(db.schedulerRun, "update").mockRejectedValueOnce(new Error("no se pudo cerrar"));
  await expect(runCycle()).resolves.toBeUndefined();
  const count = await db.schedulerRun.count();
  await runCycle();
  expect(await db.schedulerRun.count()).toBe(count + 1);
});
