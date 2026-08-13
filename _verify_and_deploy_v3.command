#!/bin/bash
set -uo pipefail
cd "/Users/ramonminguet/Downloads/RMSelection/backend"
LOG="/Users/ramonminguet/Downloads/RMSelection/backend/_verify_deploy_v3.log"
: > "$LOG"

echo "=== 1) tsc --noEmit (typecheck) ===" | tee -a "$LOG"
npx tsc -p tsconfig.json --noEmit >> "$LOG" 2>&1
TSC_STATUS=$?
echo "tsc exit: $TSC_STATUS" | tee -a "$LOG"

if [ $TSC_STATUS -ne 0 ]; then
  echo "=== TYPECHECK FALLÓ — NO SE HACE PUSH ===" | tee -a "$LOG"
  exit 1
fi

echo "=== 2) git add + commit ===" | tee -a "$LOG"
git add -A >> "$LOG" 2>&1
git commit -m "Fix: conformationScoresJson debe ser plano (id->puntaje), no anidado por vista

La forma nested {lateral:{...},frontal:{...},posterior:{...}} rompía la
decodificación en iOS (HipAnalysisDTO.conformationScoresJson: [String:
Double], mismo patrón que ya usaba la metodología legado de 26 claves
planas). Corregido a un mapa plano con las 9 claves con punto
(lateral.proportions, etc.) — igual que ya responde la IA en el JSON del
prompt, sin necesidad de traducir de una forma a otra." >> "$LOG" 2>&1
echo "commit exit: $?" | tee -a "$LOG"

echo "=== 3) git push ===" | tee -a "$LOG"
git push origin main >> "$LOG" 2>&1
PUSH_STATUS=$?
echo "push exit: $PUSH_STATUS" | tee -a "$LOG"

echo "=== DONE ===" | tee -a "$LOG"
