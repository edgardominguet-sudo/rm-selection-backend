#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Analisis IA: fuente exclusiva de fotos (AI_ANALYSIS_PHOTO), nunca catalogo/Media"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
