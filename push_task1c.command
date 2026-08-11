#!/bin/bash
set -e
cd "/Users/ramonminguet/Downloads/RMSelection/backend"
echo "== Limpiando locks de git viejos =="
find .git -name "*.lock" -delete 2>/dev/null || true
echo "== git status =="
git status --short
echo "== git add + commit =="
git add -A
git commit -m "Fix: GET de fotos del referente quedaba detras de requireApiKey

El middleware global requireApiKey (index.ts) corre ANTES que el router
de routes.ts, asi que definir el GET publico ahi no servia -- nunca se
ejecutaba, siempre devolvia 401 antes de llegar. Se mueve el handler a
index.ts, montado antes de requireApiKey, para que analyzeHip pueda
hacer fetch() de la foto sin ningun header. Confirmado con smoke test
real: antes HTTP 401, con este fix HTTP 200 sirviendo la imagen." || echo "(nada para commitear)"
echo "== git push =="
git push origin main
echo ""
echo "=================================="
echo "LISTO. Podes cerrar esta ventana."
echo "=================================="
read -n 1 -s -r -p "Presiona una tecla para cerrar..."
