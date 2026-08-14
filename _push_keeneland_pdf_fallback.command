#!/bin/bash
cd /Users/ramonminguet/Downloads/RMSelection/backend || exit 1
echo "=== npm install (agrega pdf-parse al lockfile) ==="
npm install
echo "=== npx tsc --noEmit (chequeo de tipos antes de subir nada) ==="
npx tsc --noEmit -p tsconfig.json
TSC_STATUS=$?
if [ $TSC_STATUS -ne 0 ]; then
  echo "=== tsc encontro errores (arriba) — NO se hace commit/push. ==="
  echo "==== listo, presiona Enter para cerrar ===="
  read
  exit 1
fi
echo "=== tsc OK, haciendo commit y push ==="
git add -A
git commit -m "Keeneland: mecanismo de respaldo via PDFs de pedigree por Hip (September Yearling Sale 2026)"
git push origin main
echo "==== listo, presiona Enter para cerrar ===="
read
