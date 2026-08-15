#!/bin/bash
cd "$(dirname "$0")"
set -e
rm -f .git/HEAD.lock .git/index.lock
npm install
npx prisma generate
npx tsc --noEmit
echo "=== TYPECHECK OK ==="
git add -A
git commit -m "Consistencia izquierda/derecha + estabilizar toe_in/toe_out (Frontal): la prueba de 10 corridas del fix de baseWidthRatio mostro que baseWidthRatio quedo estable pero la categoria general seguia alternando Excelente/Bien 2/10 por toe_in/toe_out y hoof_asymmetry, y se detecto ademas una inversion real de lado (izquierda/derecha) del modelo de vision en 1 de 10 corridas. Autorizado por Ramon: (1) nueva verificacion determinista de consistencia izquierda/derecha en landmarkVisionClient.ts (landmarkSideConsistency.ts) que corrige la IDENTIFICACION del lado antes de calcular cualquier hallazgo, aplicada a Frontal y Posterior; (2) toe_in/toe_out ahora promedia fetlock-hoofToe y fetlock-hoofHeel (2 mediciones independientes de la misma rotacion del casco) en vez de un solo segmento corto, igual principio que baseWidthRatio. hoof_asymmetry NO se toco todavia -- se recolectan datos reales primero. No se cambio ninguna tolerancia ni criterio anatomico. Diagnostico temporal /_diag/frontalrepeat ahora tambien reporta el lado (side) de cada hallazgo y mas landmarks crudos." || true
git push origin main
echo "=== DEPLOY SCRIPT DONE ==="
