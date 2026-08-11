#!/bin/bash
set -e
cd "/Users/ramonminguet/Downloads/RMSelection/backend"
echo "== Limpiando locks de git viejos =="
find .git -name "*.lock" -delete 2>/dev/null || true
echo "== git status =="
git status --short
echo "== git add + commit =="
git add -A
git commit -m "Tarea 1: analisis RM reproducible - endpoint on-demand server-side

Agrega analyzeHipOnDemand() (rankingService.ts) que reutiliza el mismo
pipeline de analyzeAndRankSession (analyzeHip + AnalysisResult +
CurrentHipAnalysis) para analizar un Hip puntual a pedido de un
dispositivo, con advisory lock de Postgres para que dos pedidos
simultaneos del mismo Hip nunca generen dos analisis distintos.

Agrega GET/POST /api/v1/hips/:hipId/analysis (routes.ts): GET lee el
analisis vigente sin gastar nada, POST dispara/reutiliza el analisis
oficial. El backend pasa a ser la unica fuente del resultado - ya no
cada dispositivo corre su propio analisis de IA por separado." || echo "(nada para commitear, ya estaba commiteado)"
echo "== git push =="
git push origin main
echo ""
echo "=================================="
echo "LISTO. Podes cerrar esta ventana."
echo "=================================="
read -n 1 -s -r -p "Presiona una tecla para cerrar..."
