#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Motor profesional de Analisis Anatomico RM: landmarks + geometria determinista + biblioteca de conformacion + scoring reproducible" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
