#!/bin/bash
cd "$(dirname "$0")"
API_KEY="rm-selection-8f3k2m9xq7v4n1w6"
BASE="https://rm-selection-backend-production.up.railway.app/api/v1"
SARATOGA_ID="cmsq3e89e001rehngdb21dnmz"
NY_BRED_ID="cmsko2sy10008uex8alfduajb"

echo "=== 2a) Corrida MANUAL: Fasig-Tipton — Saratoga (FULL, deberia funcionar) ==="
curl -s -X POST -H "x-api-key: $API_KEY" "$BASE/sales/$SARATOGA_ID/media-sweep" | python3 -m json.tool
echo ""
echo "=== 2b) Corrida MANUAL: Fasig-Tipton — New York Bred Yearlings (MANUAL_CSV, se espera error explicativo, NO un 'no encontro nada') ==="
curl -s -X POST -H "x-api-key: $API_KEY" "$BASE/sales/$NY_BRED_ID/media-sweep" | python3 -m json.tool
echo ""
echo "=== 3) Historial de corridas (GET /media-sweep/runs) ==="
curl -s -H "x-api-key: $API_KEY" "$BASE/media-sweep/runs?limit=5" | python3 -m json.tool
echo ""
echo "=== FIN DIAGNOSTICO ==="
