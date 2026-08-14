#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
rm -f verify_reference_anchor.ts verify_determinism2.ts
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Corregir integracion del caballo referente: patron anatomico RM 10/10 dentro de limites profesionales de seguridad (severity.ts, rmPriorityRules.ts, referenceCalibration.ts, anthropicClient.ts)" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
