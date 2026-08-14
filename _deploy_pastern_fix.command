#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
rm -f verify_reference_anchor.ts verify_determinism2.ts verify_pastern_bug.ts verify_pastern_fix2.ts
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Fix real: angulo cuartilla-suelo (upright/long-sloping pastern) daba siempre -90 a -105 grados por bug de signo en angleFromVertical; angleFromGroundPlane nuevo lo corrige" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
