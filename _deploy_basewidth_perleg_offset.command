#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Reintento estabilizacion baseWidthRatio (Frontal): el primer intento (promediar hombro+carpo+menudillo) fallo en prueba real de 10 corridas (rango -0.71 a +0.15, cambio de categoria en 4/10). Nuevo enfoque: base_narrow/base_wide ahora se calculan como el offset horizontal de cada casco respecto al hombro DE SU MISMA pata, normalizado por el largo hombro-casco de esa pata (mismo patron que carpus_valgus/varus y toe_in/toe_out, que fueron mas estables en la misma prueba). No se tocaron bandas de tolerancia ni criterios anatomicos ni Lateral/Posterior. Diagnostico temporal /_diag/frontalrepeat ahora tambien captura landmarks crudos por corrida." || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
