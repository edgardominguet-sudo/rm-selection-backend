#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Diagnostico temporal: /diag/sales-overview (investigacion Fasig-Tipton/Keeneland/OBS)"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
