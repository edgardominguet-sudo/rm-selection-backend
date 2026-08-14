#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
git add -A
git commit -m "Diagnostico temporal: probar idempotencia del barrido nocturno de Media" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
