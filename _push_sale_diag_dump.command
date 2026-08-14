#!/bin/bash
set -e
cd "/Users/ramonminguet/Downloads/RMSelection/backend"

echo "=== npm install ==="
npm install

echo "=== prisma generate ==="
npx prisma generate

echo "=== typecheck (tsc --noEmit) ==="
npx tsc -p tsconfig.json --noEmit

echo "=== git add + commit ==="
git add -A
git commit -m "Diagnostico temporal: dump de todas las Sale (isActive/catalogAccess) al arrancar" || echo "(nada nuevo para commitear)"

echo "=== git push origin main ==="
git push origin main

echo "=== LISTO. Presiona Enter para cerrar ==="
read
