#!/bin/bash
cd "$(dirname "$0")"
API_KEY="rm-selection-8f3k2m9xq7v4n1w6"
BASE="https://rm-selection-backend-production.up.railway.app/api/v1"

echo "=== 1) Listando ventas (buscando Fasig-Tipton Saratoga / NY Bred Yearlings) ==="
curl -s -H "x-api-key: $API_KEY" "$BASE/sales" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for s in data:
    print(s.get('id'), '|', s.get('name'), '|', s.get('house'), '|', s.get('catalogAccess'), '|', 'externalSaleId=' + str(s.get('externalSaleId')), '|', 'active=' + str(s.get('isActive')))
"
echo ""
echo "=== FIN DIAGNOSTICO ==="
