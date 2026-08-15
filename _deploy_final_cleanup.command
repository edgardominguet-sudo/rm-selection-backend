#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
rm -f _deploy_fix_multirun_subject.command _deploy_pastern_fix.command _deploy_recalibrate.command _deploy_reference_anchor.command _deploy_repro_cleanup.command _deploy_timeout_and_logging.command
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Limpieza final: quitar endpoints de diagnostico temporal /_diag/multirun (prueba de reproducibilidad ya documentada) y scripts de deploy ya usados" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
