#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Tarea 1: base historica propia de RM Selection (OfficialSaleResult)"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
