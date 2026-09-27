// Red de seguridad del PROCESO (2026-09-26, pedido explícito de Ramon).
//
// Los errores de las rutas ya los captura asyncRouter.ts + errorHandler.ts,
// y los ciclos automáticos y el WebSocket tienen su propio try/catch. Esto
// cubre lo que igual pudiera escaparse:
//  - Una promesa rechazada sin manejar: se REGISTRA con una marca visible
//    (UNHANDLED-REJECTION) y el servidor SIGUE funcionando. Antes, esto
//    terminaba el proceso entero (comportamiento por defecto de Node).
//  - Una excepción sincrónica no capturada: se registra y el proceso se
//    reinicia de forma controlada (Railway lo levanta de nuevo) — ahí el
//    estado interno del proceso podría haber quedado inconsistente, y
//    reiniciar es lo seguro.
let installed = false;

export function installProcessSafetyNet(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[process] UNHANDLED-REJECTION (capturada; el servidor sigue funcionando):", reason);
  });
  process.on("uncaughtException", (err, origin) => {
    console.error(`[process] UNCAUGHT-EXCEPTION (${origin}) — reinicio controlado del proceso:`, err);
    process.exit(1);
  });
}
