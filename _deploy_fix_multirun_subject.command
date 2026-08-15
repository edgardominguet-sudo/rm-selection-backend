#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Diagnostico multirun: usar siempre las 3 fotos fijas del referente (un Hip real podia acumular mas de 3 fotos de Analisis IA, violando 'exactamente las mismas tres fotografias' y disparando el tiempo de cada corrida)" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
