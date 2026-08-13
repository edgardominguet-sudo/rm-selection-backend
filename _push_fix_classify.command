#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Fix: clasificacion real de resultado (Fasig-Tipton usa purchaser, no sold_as_code) + columna normalizedStatus separada del dato crudo"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
