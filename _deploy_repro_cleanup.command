#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
rm -f determinism_check.ts determinism_check2.ts determinism_check3.ts
rm -f _deploy_repro_test.command _deploy_repro_test2.command _deploy_repro_test3.command
rm -f _deploy_repro_diag.command _deploy_repro_fix.command _deploy_landmark_engine.command
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Limpieza: quitar endpoints de diagnostico temporal de reproducibilidad y scripts de deploy ya usados" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
