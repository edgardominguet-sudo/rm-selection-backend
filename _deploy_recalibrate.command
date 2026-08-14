#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Invalidar cache de calibracion del referente cuando cambia la formula del motor (version salt en el hash)" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
