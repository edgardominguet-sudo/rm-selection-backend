#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/HEAD.lock
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
