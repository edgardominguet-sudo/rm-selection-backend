#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Fix real: llamadas a Anthropic sin timeout se podian colgar indefinidamente sin lanzar excepcion (visto durante prueba de reproducibilidad); agregado timeout de 4 min por llamada + logging de duracion por corrida en el diagnostico temporal" || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
