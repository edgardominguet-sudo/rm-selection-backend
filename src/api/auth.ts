import { Request, Response, NextFunction } from "express";
import { User } from "@prisma/client";
import { db } from "../db";
import { config } from "../config";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Autenticación por clave (header "x-api-key"), pero ahora la clave
 * identifica a un `User` concreto en vez de ser un secreto suelto — esto es
 * lo que permite que las decisiones/observaciones que se guardan queden
 * asociadas a alguien desde el día uno, sin tener que construir login
 * todavía (ver ARCHITECTURE.md, sección 2). El día que haga falta una
 * segunda persona con cuenta propia, se agrega un segundo mecanismo de auth
 * (JWT/login) que también termina resolviendo `req.user` — nada de lo que
 * ya está construido sobre `req.user` tiene que cambiar.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Se acepta también por query string ("?apiKey=...") además del header
  // "x-api-key" — solo para permitir navegar a mano rutas GET puntuales
  // (ej. /sales/resync) directo desde un browser, donde no se puede
  // fijar un header custom sin herramientas adicionales. Mismo secreto,
  // ninguna ruta nueva, no afecta a los clientes existentes que ya mandan
  // el header (iOS sigue igual).
  const provided = req.header("x-api-key") ?? (typeof req.query.apiKey === "string" ? req.query.apiKey : undefined);

  if (!provided) {
    if (!config.appApiKey) {
      console.warn("[auth] Ni APP_API_KEY ni ningún usuario con clave están configurados — la API está abierta sin autenticación.");
      next();
      return;
    }
    res.status(401).json({ error: "API key inválida o faltante." });
    return;
  }

  const user = await db.user.findUnique({ where: { apiKey: provided } });
  if (!user) {
    res.status(401).json({ error: "API key inválida o faltante." });
    return;
  }
  req.user = user;
  next();
}

/** Para rutas que necesitan sí o sí un usuario resuelto (ej. decisiones/observaciones). */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Esta acción requiere una API key válida asociada a un usuario." });
    return;
  }
  next();
}
