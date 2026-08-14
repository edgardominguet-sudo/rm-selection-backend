#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Casas de venta: GET /sales/hips (catalogo ya importado), dedup por fecha en descubrimiento, diag temporal"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
