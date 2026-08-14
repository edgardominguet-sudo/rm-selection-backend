#!/bin/bash
set -e
cd "/Users/ramonminguet/Downloads/RMSelection/backend"

echo "=== npm install ==="
npm install

echo "=== prisma generate ==="
npx prisma generate

echo "=== typecheck (tsc --noEmit) ==="
npx tsc -p tsconfig.json --noEmit

echo "=== git status ==="
git status

echo "=== git add + commit ==="
git add -A
git commit -m "Calendario de Ventas: modelo SaleDay + resolucion automatica Keeneland (Hip Grouping PDF)" || echo "(nada nuevo para commitear)"

echo "=== git push origin main ==="
git push origin main

echo "=== LISTO. Presiona Enter para cerrar ==="
read
