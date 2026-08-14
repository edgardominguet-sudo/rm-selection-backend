#!/bin/bash
cd /Users/ramonminguet/Downloads/RMSelection/backend || exit 1
echo "=== npx tsc --noEmit ==="
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
git commit -m "Diagnostico temporal: modo raw en /diag/keeneland-pdf-probe para depurar parseo"
git push origin main
echo "==== listo, presiona Enter para cerrar ===="
read
