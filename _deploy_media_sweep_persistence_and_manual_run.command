#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Sincronizacion de Media: persistencia de estado + corrida manual + distincion no-publicado/no-encontrado. Tarea explicita de Ramon 2026-08-15 (eliminar de raiz el trigger de busqueda de fotos/video durante uso normal de la app, dejar un solo barrido automatico diario a las 3am, y poder probarlo manualmente contra Fasig-Tipton sin esperar al cron). Cambios de este commit (lado backend; el lado iOS que elimina los triggers reales va en un commit aparte):
(1) Nuevo modelo MediaSweepRun (schema.prisma + migracion SQL a mano) que registra cada corrida (automatica o manual): trigger, status, contadores (ventas revisadas/omitidas, Hips revisados, Hips con media nueva, recursos nuevos encontrados), errorMessage y un detailsJson con el detalle por venta -- reemplaza depender solo de logs de Railway (que rotan) para responder '\''¿corrio anoche? ¿que encontro?'\''.
(2) mediaSweepService.ts reescrito: runNightlyMediaSweep ahora acepta opts.trigger ('\''scheduled'\''|'\''manual'\'') y opts.saleId opcional (para acotar una corrida a una sola venta puntual, sin tener que barrer todas). Crea y actualiza el MediaSweepRun al empezar/terminar. Nuevo campo hipsWithoutMediaYet por venta: distingue explicitamente '\''la casa de ventas todavia no publico media para este Hip'\'' (catalogo fresco sin nada) de un problema real de nuestro lado (que sigue cayendo en errors) -- para Fasig-Tipton/Keeneland la media es un campo directo de la respuesta de catalogo, no un scraping aparte que pueda fallar independiente. countNewResources() cuenta fotos/videos realmente nuevos (por URL) para no confundir '\''Hips con cambios'\'' con '\''recursos nuevos'\''. Ventas no-FULL (MANUAL_CSV) pedidas puntualmente por saleId ahora informan un error claro en vez de silenciosamente no hacer nada.
(3) scheduler.ts: el log del cron de 3am ahora incluye runId y Hips revisados/recursos nuevos (antes solo ventas revisadas).
(4) routes.ts: dos endpoints nuevos -- POST /api/v1/sales/:saleId/media-sweep (corrida manual controlada de UNA venta, para probar Fasig-Tipton Saratoga/NY sin esperar al cron ni tocar las demas ventas) y GET /api/v1/media-sweep/runs (historial de corridas, mas reciente primero).
No se toco el motor de Analisis IA ni ninguna decision del Metodo RM -- cambio acotado al subsistema de deteccion/descarga/almacenamiento de fotos y video de catalogo, tal como se pidio explicitamente." || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
