#!/bin/bash
set -uo pipefail
cd "/Users/ramonminguet/Downloads/RMSelection/backend"
LOG="/Users/ramonminguet/Downloads/RMSelection/backend/_verify_deploy_v2.log"
: > "$LOG"

echo "=== 1) prisma generate ===" | tee -a "$LOG"
npx prisma generate >> "$LOG" 2>&1
PRISMA_STATUS=$?
echo "prisma generate exit: $PRISMA_STATUS" | tee -a "$LOG"

echo "=== 2) tsc --noEmit (typecheck) ===" | tee -a "$LOG"
npx tsc -p tsconfig.json --noEmit >> "$LOG" 2>&1
TSC_STATUS=$?
echo "tsc exit: $TSC_STATUS" | tee -a "$LOG"

if [ $PRISMA_STATUS -ne 0 ] || [ $TSC_STATUS -ne 0 ]; then
  echo "=== TYPECHECK FALLÓ — NO SE HACE PUSH ===" | tee -a "$LOG"
  exit 1
fi

echo "=== 3) git status ===" | tee -a "$LOG"
git status >> "$LOG" 2>&1

echo "=== 4) git add + commit ===" | tee -a "$LOG"
git add -A >> "$LOG" 2>&1
git commit -m "Nuevo caballo referente y motor de Análisis IA: anatomía comparativa por vista (LATERAL/FRONTAL/POSTERIOR), sin Marcha

- Reemplaza el motor legado (26 subcategorías, 3 bloques, incluía Marcha)
  por comparación de estructura anatómica: 9 parámetros agrupados en
  3 vistas fijas (lateral/frontal/posterior), una por foto del referente.
- Clasificación automática de fotos del Hip por vista + validación de
  encuadre/perspectiva antes de puntuar (nunca inventa medidas de una
  foto mal tomada).
- Umbrales nuevos: EXCELENTE 8.5-10.0, BIEN 7.0-8.4, REVISAR 0.0-6.9
  (valores internos Comprar/Revisar/Descartar sin cambios, por compat.).
- Vista sin foto válida no promedia como 0 (falta != defecto).
- Marcha queda fuera del promedio de IA (evaluación del comprador en
  la inspección presencial).
- Cambios de esquema aditivos, sin tocar filas/columnas legado." >> "$LOG" 2>&1
echo "commit exit: $?" | tee -a "$LOG"

echo "=== 5) git push ===" | tee -a "$LOG"
git push origin main >> "$LOG" 2>&1
PUSH_STATUS=$?
echo "push exit: $PUSH_STATUS" | tee -a "$LOG"

echo "=== DONE ===" | tee -a "$LOG"
