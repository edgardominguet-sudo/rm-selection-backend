// Manejador de errores CENTRAL de la API (2026-09-26, pedido explícito de
// Ramon). Recibe todo error que una ruta o middleware derive a `next(err)`
// — ver asyncRouter.ts — y SIEMPRE responde: un JSON con un código HTTP
// adecuado, nunca una petición colgada ni el proceso caído. Solo informa:
// nunca escribe, modifica ni borra datos.
import type { ErrorRequestHandler } from "express";

/** Error con código HTTP explícito, para validar entradas dentro de una ruta (ej. un `since` inválido). */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string = "BAD_REQUEST") {
    super(message);
    this.name = "HttpError";
  }
}

export interface ClassifiedError {
  status: number;
  code: string;
  message: string;
}

// Códigos de error de Prisma (https://www.prisma.io/docs/orm/reference/error-reference).
// Se reconocen por `name`/`code` y no por clase, para que funcione igual
// con cualquier motor de Prisma.
const PRISMA_NOT_FOUND = new Set(["P2025", "P2001", "P2015", "P2018"]);
const PRISMA_INVALID_REFERENCE = new Set(["P2003", "P2014"]);
const PRISMA_CONFLICT = new Set(["P2002", "P2034"]);
const PRISMA_BAD_INPUT = new Set(["P2000", "P2005", "P2006", "P2007", "P2008", "P2009", "P2011", "P2012", "P2013", "P2019", "P2020", "P2023"]);
const PRISMA_UNAVAILABLE = new Set(["P1000", "P1001", "P1002", "P1008", "P1011", "P1017", "P2024"]);

/** Traduce cualquier error a un código HTTP y un mensaje seguro para el cliente (sin detalles internos). */
export function classifyError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as { name?: string; code?: string; status?: number; statusCode?: number; type?: string; message?: string };

  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };

  // Errores del lector de JSON de Express (body-parser).
  if (e.type === "entity.parse.failed") return { status: 400, code: "INVALID_JSON", message: "El cuerpo de la petición no es un JSON válido." };
  if (e.type === "entity.too.large") return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "El cuerpo de la petición es demasiado grande." };

  const name = e.name ?? "";
  if (name === "PrismaClientKnownRequestError" && typeof e.code === "string") {
    if (PRISMA_NOT_FOUND.has(e.code)) return { status: 404, code: "NOT_FOUND", message: "El registro no existe." };
    if (PRISMA_INVALID_REFERENCE.has(e.code)) return { status: 400, code: "INVALID_REFERENCE", message: "La petición hace referencia a un registro que no existe (Hip, dispositivo u otro)." };
    if (PRISMA_CONFLICT.has(e.code)) return { status: 409, code: "CONFLICT", message: "Conflicto con un registro existente. Reintentá la operación." };
    if (PRISMA_BAD_INPUT.has(e.code)) return { status: 400, code: "INVALID_DATA", message: "Datos inválidos en la petición." };
    if (PRISMA_UNAVAILABLE.has(e.code)) return { status: 503, code: "DATABASE_UNAVAILABLE", message: "La base de datos no está disponible en este momento. Reintentá en unos segundos." };
  }
  if (name === "PrismaClientValidationError") return { status: 400, code: "INVALID_DATA", message: "Datos inválidos en la petición." };
  if (name === "PrismaClientInitializationError") return { status: 503, code: "DATABASE_UNAVAILABLE", message: "La base de datos no está disponible en este momento. Reintentá en unos segundos." };

  // Otros errores que ya traen un código HTTP 4xx propio.
  const explicit = e.status ?? e.statusCode;
  if (typeof explicit === "number" && explicit >= 400 && explicit < 500) {
    return { status: explicit, code: "BAD_REQUEST", message: e.message ?? "Petición inválida." };
  }

  return { status: 500, code: "INTERNAL_ERROR", message: "Error interno del servidor. El cambio no se aplicó; se puede reintentar." };
}

/** Se monta UNA vez, al final de la app (después de todas las rutas). */
export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const classified = classifyError(err);
  // `req.path` (sin query string) para no volcar nunca una apiKey al log.
  const context = `${req.method} ${req.baseUrl}${req.path} user=${req.user?.id ?? "-"} status=${classified.status} code=${classified.code}`;
  if (classified.status >= 500) {
    console.error(`[api-error] ${context}`, err);
  } else {
    const detail = err instanceof Error ? `${err.name}: ${err.message.split("\n").filter(Boolean).slice(-1)[0] ?? ""}` : String(err);
    console.warn(`[api-error] ${context} -- ${detail}`);
  }
  // Si la ruta ya había empezado a responder, Express cierra la conexión
  // por su cuenta — no se puede mandar otra respuesta encima.
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(classified.status).json({ error: classified.message, code: classified.code });
};
