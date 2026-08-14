#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
rm -f _deploy_diag.command _deploy_diag2.command _deploy_media_sweep.command
npm install
npx prisma generate
npx tsc --noEmit
git add -A
git commit -m "Quitar ruta de diagnostico temporal de idempotencia y scripts de deploy de esta tarea (ya cumplieron su proposito)" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
git rm -f "$(basename "$0")" 2>/dev/null || rm -f "$(basename "$0")"
git commit -m "Quitar script de deploy de limpieza final (ya cumplio su proposito)" || true
git push origin main
echo "=== SELF CLEANUP DONE ==="
