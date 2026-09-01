import { Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { db } from "./db";
import { config } from "./config";

/// Canal de sincronización EN TIEMPO REAL entre iPhone/iPad (2026-09-01, a
/// pedido explícito: "implementa sincronización bidireccional automática
/// en tiempo real"). Antes de esto, la sincronización entre dispositivos
/// era enteramente por sondeo (polling): cada dispositivo pregunta "¿qué
/// cambió?" cada 30s (SyncEngine, en general) o cada 6s (con un Hip
/// abierto) — funciona, pero un cambio hecho en un dispositivo podía
/// tardar hasta esos 30s/6s en verse en el otro. Eso NO es "tiempo real".
///
/// Este módulo agrega un WebSocket muy simple: cada dispositivo abre UNA
/// conexión persistente al arrancar la app, y cuando CUALQUIER dispositivo
/// hace un cambio (decisión, nota, foto/video, reporte veterinario,
/// anotación de pedigree, análisis, Hip reciente), el servidor avisa por
/// ese socket a TODOS los dispositivos conectados con un mensaje mínimo
/// (`{"type":"changed"}`) — sin el dato en sí, solo un "algo cambió,
/// andá a preguntar". Cada dispositivo, al recibirlo, dispara enseguida
/// el mismo ciclo de sincronización delta que ya existía (pull con
/// `since=`) — se reutiliza TODO el mecanismo de fusión ya probado
/// (outbox, tombstones, "no pisar una edición local todavía pendiente"),
/// solo que ahora arranca en cuanto hay algo nuevo en vez de esperar el
/// próximo tick del timer. El polling de 30s/6s se deja intacto como red
/// de respaldo (si el socket se cae, la app igual se pone al día sola en
/// ese lapso) — este canal es una aceleración, no un reemplazo.
///
/// No hace falta enrutar el aviso "a la cuenta de tal usuario": hoy toda
/// la app es de una sola organización/usuario (ver User/apiKey), así que
/// "todos los dispositivos conectados" y "todos los dispositivos de este
/// usuario" son lo mismo. El día que haya una segunda cuenta, este
/// broadcast se filtra por `userId` — la estructura ya deja lugar (cada
/// socket guarda su `userId` al autenticarse).

interface TrackedSocket {
  socket: WebSocket;
  userId: string;
  isAlive: boolean;
}

const sockets = new Set<TrackedSocket>();

/// Avisa a todos los dispositivos conectados (de cualquier cuenta, hoy hay
/// una sola) que algo cambió — se llama justo después de que un endpoint
/// de escritura (PUT/POST/DELETE de decisiones, observaciones, media,
/// anotaciones de pedigree, análisis, Hips recientes) confirma el cambio
/// en la base. `origin.deviceId` viaja en el mensaje (no se usa para
/// filtrar hoy, pero deja lista la traza para diagnóstico: "¿quién
/// disparó este aviso?" en los logs del cliente si hiciera falta).
export function broadcastChange(kind: string, originDeviceId?: string | null): void {
  if (sockets.size === 0) return;
  const message = JSON.stringify({ type: "changed", kind, originDeviceId: originDeviceId ?? null, at: new Date().toISOString() });
  for (const tracked of sockets) {
    if (tracked.socket.readyState === WebSocket.OPEN) {
      tracked.socket.send(message);
    }
  }
}

/// Se llama una sola vez desde index.ts, sobre el mismo `http.Server` que
/// ya levanta Express (`app.listen(...)`) — un WebSocketServer puede vivir
/// en el mismo puerto sin pisar las rutas HTTP normales, distinguiéndose
/// por la ruta de "upgrade" ("/ws").
export function attachRealtime(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket, request) => {
    // Misma autenticación que el resto de la API (x-api-key), pero acá
    // viaja por query string: el handshake de WebSocket es un GET normal,
    // y algunos proxies/CDNs no dejan pasar headers custom en el upgrade —
    // la query string siempre llega intacta. Mismo secreto de siempre, sin
    // rutas nuevas de autenticación que mantener.
    const url = new URL(request.url ?? "", "http://localhost");
    const apiKey = url.searchParams.get("apiKey");
    if (!apiKey) {
      socket.close(4001, "Falta apiKey");
      return;
    }
    const user = await db.user.findUnique({ where: { apiKey } });
    if (!user) {
      socket.close(4001, "apiKey inválida");
      return;
    }

    const tracked: TrackedSocket = { socket, userId: user.id, isAlive: true };
    sockets.add(tracked);

    socket.on("pong", () => {
      tracked.isAlive = true;
    });
    socket.on("close", () => {
      sockets.delete(tracked);
    });
    socket.on("error", () => {
      sockets.delete(tracked);
    });
  });

  // Ping cada 30s: (1) mantiene viva la conexión a través de proxies que
  // cierran sockets inactivos (Railway incluido — sin tráfico periódico,
  // algunos proxies cortan alrededor de los 60-120s); (2) descarta sockets
  // muertos que nunca dispararon un evento "close" limpio (ej. el
  // dispositivo perdió señal de golpe) — si no contestó el ping anterior
  // con un pong, se cierra y se saca del set.
  const interval = setInterval(() => {
    for (const tracked of sockets) {
      if (!tracked.isAlive) {
        tracked.socket.terminate();
        sockets.delete(tracked);
        continue;
      }
      tracked.isAlive = false;
      tracked.socket.ping();
    }
  }, 30_000);
  interval.unref();

  console.log(`[realtime] WebSocket de sincronización en tiempo real listo en /ws (clave requerida: ${config.appApiKey ? "sí" : "no configurada"})`);
}
