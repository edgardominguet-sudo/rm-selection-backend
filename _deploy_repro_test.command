#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Diagnostico temporal: endpoint de prueba de reproducibilidad del motor anatomico" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
