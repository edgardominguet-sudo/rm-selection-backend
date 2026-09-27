// Captura de errores asíncronos en TODAS las rutas (2026-09-26, pedido
// explícito de Ramon tras el diagnóstico "el servidor se cae ante un error
// inesperado").
//
// CAUSA RAÍZ que esto corrige: Express 4 no captura el rechazo de una
// función `async`. Si una ruta async fallaba (ej. un Hip que no existe, un
// `since` inválido, la base de datos sin responder), el error quedaba como
// promesa rechazada sin manejar y Node terminaba el PROCESO ENTERO (Railway
// lo reiniciaba) — cortando a la vez todas las demás peticiones, el
// WebSocket de sincronización y los ciclos automáticos en curso.
//
// withAsyncErrors envuelve los métodos de registro de rutas de un router o
// de la app (get/post/put/patch/delete/all/use) para que CUALQUIER handler
// o middleware, async o no, derive su error a `next(err)` — es decir, al
// manejador central (errorHandler.ts). Se aplica una sola vez al crear el
// router/la app: ninguna ruta necesita su propio try/catch para esto, y el
// comportamiento de las rutas que funcionan bien no cambia en nada.
import type { NextFunction, Request, Response } from "express";

type AnyFn = (...args: unknown[]) => unknown;

const REGISTRATION_METHODS = ["get", "post", "put", "patch", "delete", "all", "use"] as const;

function isMountable(fn: unknown): boolean {
  // Un Router o una sub-app de Express (tienen `.handle`) se montan tal
  // cual — sus propias rutas se envuelven al crearlos con withAsyncErrors.
  return typeof fn === "function" && typeof (fn as { handle?: unknown }).handle === "function";
}

/** Envuelve un handler/middleware para que un error (sincrónico o una promesa rechazada) llegue a `next(err)`. */
export function wrapAsync<T>(fn: T): T {
  if (typeof fn !== "function") return fn;
  if (isMountable(fn)) return fn;
  // Los manejadores de error de Express se reconocen por tener 4 parámetros
  // — se dejan intactos para no cambiar cómo Express los detecta.
  if ((fn as AnyFn).length === 4) return fn;
  const original = fn as unknown as (req: Request, res: Response, next: NextFunction) => unknown;
  const wrapped = function (this: unknown, req: Request, res: Response, next: NextFunction) {
    try {
      const result = original.call(this, req, res, next);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(undefined, next);
      }
    } catch (err) {
      next(err);
    }
  };
  return wrapped as unknown as T;
}

function wrapArg(arg: unknown): unknown {
  return Array.isArray(arg) ? arg.map(wrapArg) : wrapAsync(arg);
}

/** Aplica wrapAsync a todo lo que se registre en este router o app de acá en más. Devuelve el mismo objeto. */
export function withAsyncErrors<T extends object>(target: T): T {
  const t = target as unknown as Record<string, AnyFn>;
  for (const method of REGISTRATION_METHODS) {
    const original = t[method];
    if (typeof original !== "function") continue;
    t[method] = function (this: unknown, ...args: unknown[]) {
      return original.apply(target, args.map(wrapArg));
    };
  }
  return target;
}
