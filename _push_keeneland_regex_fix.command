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
git commit -m "Keeneland PDF fallback: arreglar regex de Dam/Sire con sufijo de pais entre parentesis (ej. LOVEE DOVEE (GB))"
git push origin main
echo "==== listo, presiona Enter para cerrar ===="
read
