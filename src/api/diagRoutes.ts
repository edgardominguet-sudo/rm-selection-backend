import { Router } from "express";
import { withAsyncErrors } from "./asyncRouter";
import { db } from "../db";

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

export const diagRouter = withAsyncErrors(Router()); // ver asyncRouter.ts

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

// MARK: - Cierres inesperados de la app (2026-10-04)
//
// MetricKit entrega en el siguiente arranque los informes de cierres
// (crash con su pila de llamadas), cuelgues, y el conteo de salidas por
// memoria / watchdog. La app los manda acá; quedan guardados en
// AppDiagnostic y se imprime una línea resumen en los logs de Railway
// ("APP-DIAGNOSTIC ...") para poder verlos de inmediato.
diagRouter.post("/app-diagnostics", async (req, res) => {
  const body = (req.body ?? {}) as {
    reports?: Array<{
      kind?: string;
      device?: string;
      osVersion?: string;
      appVersion?: string;
      summary?: string;
      payload?: unknown;
    }>;
  };
  const reports = Array.isArray(body.reports) ? body.reports.slice(0, 20) : [];
  let stored = 0;
  for (const r of reports) {
    const kind = typeof r.kind === "string" && r.kind ? r.kind.slice(0, 40) : "unknown";
    const summary = typeof r.summary === "string" ? r.summary.slice(0, 2000) : null;
    console.log(`APP-DIAGNOSTIC kind=${kind} device=${r.device ?? "-"} os=${r.osVersion ?? "-"} app=${r.appVersion ?? "-"} :: ${summary ?? ""}`);
    if (kind === "crash" || kind === "hang") {
      for (const line of describeDiagnosticPayload(r.payload)) {
        console.log(`APP-DIAGNOSTIC-DETAIL device=${r.device ?? "-"} :: ${line}`);
      }
    }
    await db.appDiagnostic.create({
      data: {
        kind,
        device: typeof r.device === "string" ? r.device.slice(0, 80) : null,
        osVersion: typeof r.osVersion === "string" ? r.osVersion.slice(0, 80) : null,
        appVersion: typeof r.appVersion === "string" ? r.appVersion.slice(0, 40) : null,
        summary,
        payload: (r.payload ?? {}) as object,
      },
    });
    stored += 1;
  }
  res.json({ ok: true, stored });
});

/**
 * Pila COMPLETA del hilo que falló + motivo de la excepción, a partir del
 * JSON de MetricKit (MXDiagnosticPayload). El resumen que arma la app solo
 * llega a 14 marcos — en un cierre por excepción esos son todos del
 * sistema (libc++abi, Foundation, UIKit); el marco de RM Selection que la
 * provocó está más abajo.
 */
function describeDiagnosticPayload(payload: unknown): string[] {
  const out: string[] = [];
  const p = payload as Record<string, unknown> | null;
  const diags = [
    ...((p?.crashDiagnostics as unknown[]) ?? []),
    ...((p?.hangDiagnostics as unknown[]) ?? []),
  ] as Array<Record<string, unknown>>;
  for (const d of diags.slice(0, 3)) {
    const meta = (d.diagnosticMetaData ?? {}) as Record<string, unknown>;
    const reason = meta.objectiveCexceptionReason as Record<string, unknown> | undefined;
    out.push(
      `meta exceptionType=${meta.exceptionType ?? "-"} signal=${meta.signal ?? "-"} termination=${meta.terminationReason ?? "-"} ` +
        `objc=${reason ? `${reason.exceptionName ?? ""} ${reason.className ?? ""}: ${reason.composedMessage ?? ""}` : "-"}`,
    );
    const tree = (d.callStackTree ?? {}) as Record<string, unknown>;
    const stacks = (tree.callStacks as Array<Record<string, unknown>>) ?? [];
    const thread = stacks.find((s) => s.threadAttributed === true) ?? stacks[0];
    let node = ((thread?.callStackRootFrames as Array<Record<string, unknown>>) ?? [])[0];
    const frames: string[] = [];
    while (node && frames.length < 80) {
      frames.push(`${node.binaryName ?? "?"}+0x${Number(node.offsetIntoBinaryTextSegment ?? 0).toString(16)}`);
      node = ((node.subFrames as Array<Record<string, unknown>>) ?? [])[0];
    }
    for (let i = 0; i < frames.length; i += 10) {
      out.push(`frames[${i}-${Math.min(i + 9, frames.length - 1)}] ${frames.slice(i, i + 10).join(" < ")}`);
    }
  }
  return out;
}

diagRouter.get("/app-diagnostics", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = await db.appDiagnostic.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  res.json({ reports: rows });
});
