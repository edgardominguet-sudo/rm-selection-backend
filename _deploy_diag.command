#!/bin/bash
cd "$(dirname "$0")"
set -e
npm install
npx prisma generate
npx tsc --noEmit
git add -A
git commit -m "Diagnostico temporal: auditar Media de Fasig-Tipton NY Bred Yearlings" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
