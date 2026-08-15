#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Estabilizar medicion de baseWidthRatio (Frontal): promediar hombro+carpo+menudillo como referencia proximal en vez de solo hombros, mas precision en el prompt de extraccion para landmarks de extremidades anteriores. No se tocaron bandas de tolerancia ni criterios anatomicos. Agregado diagnostico temporal /_diag/frontalrepeat para prueba de 10 corridas pedida por Ramon." || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
