// App de Express mínima para los tests de integración — monta el router
// real de producción (src/api/routes.ts) con la MISMA cadena de
// middlewares de autenticación que src/index.ts (requireApiKey → router
// en "/api/v1"), pero SIN levantar un servidor HTTP real, SIN arrancar
// los cron jobs del scheduler y SIN ninguno de los efectos secundarios
// de arrancar el proceso completo — así los tests golpean exactamente
// las mismas rutas/lógica que corren en Railway, de forma aislada y
// rápida (supertest habla directo con la app de Express, sin sockets).
import express from "express";
import cors from "cors";
import { requireApiKey } from "../../src/api/auth";
import { router } from "../../src/api/routes";

export function buildTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/v1", requireApiKey, router);
  return app;
}
