import { Router } from "express";

/**
 * DIAGNOSTICO TEMPORAL - Pedigree flash bug (2026-08-26, a pedido de
 * Ramon: "ESTO NO DEBE OCURRIR NUNCA").
 *
 * Por que existe: el bug solo se puede ver leyendo, en orden exacto, la
 * secuencia de estados (PedigreeImageState) que atraviesa cada Hip al
 * abrir su pestana de Pedigree en el iPhone/iPad reales de Ramon. La
 * consola de Xcode conectada a este entorno de trabajo solo se puede ver
 * y hacer scroll (no se puede escribir ni filtrar texto en ella desde
 * aca), asi que buscar a mano una apertura puntual de un Hip especifico
 * en un log que crece todo el tiempo con actividad de dos dispositivos
 * mezclada es practicamente imposible de precisar.
 *
 * Solucion: la app (ver PersistenceService.perfMark, del lado iOS) manda
 * una copia de CADA linea de log que empiece con "PEDIGREE-" a este
 * endpoint, ademas de imprimirla en la consola de Xcode como siempre
 * (esto es puramente aditivo - no cambia ningun comportamiento real de la
 * app, no agrega ningun delay, no toca ninguna condicion de UI). Con esto
 * puedo pedir por API la secuencia exacta de un Hip puntual (ej. "Hip
 * 51") sin depender de scrollear la consola a mano.
 *
 * BORRAR este archivo (y su app.use en index.ts, y DiagLogUploader del
 * lado iOS) en cuanto el bug de Pedigree quede confirmado resuelto con la
 * prueba final de 30+ Hips en ambos dispositivos - no es infraestructura
 * permanente del proyecto.
 */

interface DiagLogEntry {
  seq: number;
  serverTs: number;
  clientTs: number | null;
  device: string;
  message: string;
}

const MAX_ENTRIES = 8000;
const buffer: DiagLogEntry[] = [];
let nextSeq = 1;

export const diagRouter = Router();

diagRouter.post("/pedigree-log", (req, res) => {
  const body = req.body ?? {};
  const device = typeof body.device === "string" ? body.device : "unknown";

  // CORRECCION DE RAIZ (2026-09-09, ver DiagLogUploader del lado iOS):
  // antes este endpoint solo aceptaba UNA linea por request -- la app
  // mandaba un request HTTP independiente por cada perfMark, y durante
  // navegacion intensa (varios HIPNAV- por swipe) eso competia por el
  // mismo pool de conexiones/mismo backend que las llamadas reales
  // (subida de fotos, analisis de IA, sync), demorandolas. Ahora tambien
  // acepta un LOTE ("entries": [{message, clientTs}, ...]) para que
  // varias lineas lleguen en un solo request -- se sigue guardando y
  // logueando cada linea por separado, exactamente igual que antes, asi
  // que ninguna consulta existente (GET /pedigree-log, filtros por
  // Hip/device) cambia de comportamiento. El formato viejo (una sola
  // "message" suelta) se sigue aceptando para no romper ningun cliente
  // que todavia no se actualizo.
  type RawEntry = { message?: unknown; clientTs?: unknown };
  const rawEntries: RawEntry[] = Array.isArray(body.entries) && body.entries.length > 0
    ? body.entries
    : [{ message: body.message, clientTs: body.clientTs }];

  const applied: DiagLogEntry[] = [];
  for (const raw of rawEntries) {
    const message = typeof raw.message === "string" ? raw.message : JSON.stringify(raw);
    const clientTs = typeof raw.clientTs === "number" ? raw.clientTs : null;
    const entry = { seq: nextSeq++, serverTs: Date.now(), clientTs, device, message };
    buffer.push(entry);
    applied.push(entry);
  }
  while (buffer.length > MAX_ENTRIES) buffer.shift();

  // Ademas del buffer en memoria (GET /pedigree-log), imprime cada linea
  // en el log de runtime de Railway - asi se puede leer con
  // mcp__Railway__get-logs (filter: "PEDIGREE-DIAG") sin depender de que
  // este endpoint GET sea alcanzable desde ninguna red restringida.
  for (const entry of applied) {
    console.log(`PEDIGREE-DIAG seq=${entry.seq} device=${entry.device} clientTs=${entry.clientTs ?? "-"} :: ${entry.message}`);
  }

  res.status(204).end();
});

diagRouter.get("/pedigree-log", (req, res) => {
  const sinceSeq = req.query.sinceSeq ? Number(req.query.sinceSeq) : undefined;
  const hip = typeof req.query.hip === "string" ? req.query.hip : undefined;
  const device = typeof req.query.device === "string" ? req.query.device : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 1000;

  let entries = buffer;
  if (sinceSeq !== undefined && !Number.isNaN(sinceSeq)) {
    entries = entries.filter((e) => e.seq > sinceSeq);
  }
  if (hip) {
    const pattern = new RegExp(`Hip ${hip}[ \\[]`);
    entries = entries.filter((e) => pattern.test(e.message));
  }
  if (device) {
    entries = entries.filter((e) => e.device.toLowerCase() === device.toLowerCase());
  }

  const total = entries.length;
  const sliced = entries.slice(Math.max(0, entries.length - limit));

  res.json({ total, returned: sliced.length, lastSeq: nextSeq - 1, entries: sliced });
});

diagRouter.delete("/pedigree-log", (_req, res) => {
  buffer.length = 0;
  res.status(204).end();
});
