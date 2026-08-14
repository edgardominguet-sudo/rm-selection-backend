#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Limpieza: quitar endpoints temporales de diagnostico (sales-overview, deactivate-duplicate-sale)"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
