// Arnés para processCrash.test.ts: levanta un servidor Express REAL en un
// proceso Node propio (no Jest), armado con las mismas piezas que
// src/index.ts. Con HARNESS_WITHOUT_FIX=1 se arma como antes de la
// corrección, para reproducir la caída original.
import express from "express";
import { AddressInfo } from "node:net";
import { withAsyncErrors } from "../../../src/api/asyncRouter";
import { apiErrorHandler } from "../../../src/api/errorHandler";
import { installProcessSafetyNet } from "../../../src/processSafety";

const withoutFix = process.env.HARNESS_WITHOUT_FIX === "1";
if (!withoutFix) installProcessSafetyNet();

const app = withoutFix ? express() : withAsyncErrors(express());
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
// Error inesperado dentro de una ruta async (el caso real de producción).
app.get("/boom", async () => {
  await Promise.resolve();
  throw new Error("error inesperado dentro de una ruta");
});
// Promesa rechazada fuera de cualquier petición (red de seguridad global).
app.get("/stray-rejection", (_req, res) => {
  void Promise.reject(new Error("promesa rechazada suelta"));
  res.json({ ok: true });
});
if (!withoutFix) app.use(apiErrorHandler);

const server = app.listen(0, () => {
  console.log(`HARNESS_PORT=${(server.address() as AddressInfo).port}`);
});
