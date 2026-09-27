// Manejo centralizado de errores de la API (2026-09-26) — lógica pura,
// sin base de datos: traducción de errores a HTTP (errorHandler.ts) y
// captura de errores async de las rutas (asyncRouter.ts).
import express from "express";
import { classifyError, apiErrorHandler, HttpError } from "../../src/api/errorHandler";
import { wrapAsync, withAsyncErrors } from "../../src/api/asyncRouter";

function prismaKnown(code: string) {
  const err = new Error(`prisma ${code}`) as Error & { code: string };
  err.name = "PrismaClientKnownRequestError";
  err.code = code;
  return err;
}
function named(name: string) {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe("classifyError — traducción de errores de base de datos a HTTP", () => {
  test.each([
    ["P2025", 404, "NOT_FOUND"],
    ["P2001", 404, "NOT_FOUND"],
    ["P2003", 400, "INVALID_REFERENCE"],
    ["P2002", 409, "CONFLICT"],
    ["P2034", 409, "CONFLICT"],
    ["P2000", 400, "INVALID_DATA"],
    ["P2023", 400, "INVALID_DATA"],
    ["P1001", 503, "DATABASE_UNAVAILABLE"],
    ["P2024", 503, "DATABASE_UNAVAILABLE"],
  ])("Prisma %s -> %i %s", (code, status, errCode) => {
    expect(classifyError(prismaKnown(code))).toMatchObject({ status, code: errCode });
  });

  test("error de validación de Prisma (ej. fecha inválida) -> 400", () => {
    expect(classifyError(named("PrismaClientValidationError"))).toMatchObject({ status: 400, code: "INVALID_DATA" });
  });
  test("base de datos inaccesible al iniciar -> 503", () => {
    expect(classifyError(named("PrismaClientInitializationError"))).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE" });
  });
  test("código Prisma desconocido -> 500 (inesperado)", () => {
    expect(classifyError(prismaKnown("P9999")).status).toBe(500);
  });
  test("HttpError conserva su código y mensaje", () => {
    expect(classifyError(new HttpError(400, "since inválido", "INVALID_SINCE"))).toEqual({ status: 400, code: "INVALID_SINCE", message: "since inválido" });
  });
  test("JSON mal formado -> 400; cuerpo demasiado grande -> 413", () => {
    expect(classifyError(Object.assign(new Error("x"), { type: "entity.parse.failed", status: 400 })).status).toBe(400);
    expect(classifyError(Object.assign(new Error("x"), { type: "entity.too.large", status: 413 })).status).toBe(413);
  });
  test("error genérico inesperado -> 500 con mensaje seguro (sin detalles internos)", () => {
    const c = classifyError(new Error("connection string secreta en el mensaje"));
    expect(c.status).toBe(500);
    expect(c.message).not.toContain("secreta");
  });
  test("valores raros (null, string) -> 500 sin romperse", () => {
    expect(classifyError(null).status).toBe(500);
    expect(classifyError("texto").status).toBe(500);
  });
});

type Handler = (req: never, res: never, next: jest.Mock) => void;
const asHandler = (fn: unknown) => wrapAsync(fn) as unknown as Handler;

describe("wrapAsync / withAsyncErrors — captura de errores de las rutas", () => {
  test("una promesa rechazada llega a next(err)", async () => {
    const next = jest.fn();
    const err = new Error("async");
    asHandler(async () => { throw err; })({} as never, {} as never, next);
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledWith(err);
  });
  test("un throw sincrónico llega a next(err)", () => {
    const next = jest.fn();
    const err = new Error("sync");
    asHandler(() => { throw err; })({} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(err);
  });
  test("un handler que funciona bien no cambia: next no se llama con error", async () => {
    const next = jest.fn();
    const handler = jest.fn(async () => "ok");
    asHandler(handler)({} as never, {} as never, next);
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
  test("los manejadores de error (4 parámetros) y los routers montados quedan intactos", () => {
    const errorHandler = (_e: unknown, _q: unknown, _s: unknown, _n: unknown) => undefined;
    expect(wrapAsync(errorHandler)).toBe(errorHandler);
    const r = express.Router();
    expect(wrapAsync(r)).toBe(r);
  });
  test("withAsyncErrors envuelve también arrays de middlewares y no toca valores que no son funciones", () => {
    const app = withAsyncErrors(express());
    expect(() => app.get("/x", [async () => undefined, async () => undefined])).not.toThrow();
    app.set("etag", false);
    expect(app.get("etag")).toBe(false); // app.get(setting) sigue funcionando
  });
});

describe("apiErrorHandler — siempre responde", () => {
  function mockRes(headersSent = false) {
    const res: Record<string, unknown> = { headersSent };
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res as unknown as { status: jest.Mock; json: jest.Mock; headersSent: boolean };
  }
  const req = { method: "GET", baseUrl: "/api/v1", path: "/me/decisions", user: { id: "u1" } } as never;

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test("responde JSON con el código clasificado", () => {
    const res = mockRes();
    const next = jest.fn();
    apiErrorHandler(prismaKnown("P2003"), req, res as never, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_REFERENCE" }));
    expect(next).not.toHaveBeenCalled();
  });
  test("error inesperado -> 500 y queda registrado en el log", () => {
    const res = mockRes();
    apiErrorHandler(new Error("boom"), req, res as never, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(console.error).toHaveBeenCalled();
  });
  test("si la respuesta ya había empezado, delega en Express (no responde dos veces)", () => {
    const res = mockRes(true);
    const next = jest.fn();
    const err = new Error("tarde");
    apiErrorHandler(err, req, res as never, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });
});
