#!/bin/bash
cd "$(dirname "$0")"
set -e
npm install
npx prisma generate
npx tsc --noEmit
git add -A
git commit -m "Barrido nocturno de Media (3am) reemplaza polling constante; quita ruta de diagnostico temporal"
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
