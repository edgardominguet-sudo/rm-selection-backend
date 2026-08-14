#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Fix: subir max_tokens de landmarks a 8192 (causa raiz de truncamiento) + error explicito por stop_reason max_tokens" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
