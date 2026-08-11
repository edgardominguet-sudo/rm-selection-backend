#!/bin/bash
API="https://rm-selection-backend-production.up.railway.app"
KEY="rm-selection-8f3k2m9xq7v4n1w6"

# 1x1 pixel JPEG, solo para probar el mecanismo de guardado/lectura -- NO
# se usa como caballo referente real (no se llama a PUT /reference-horse).
PIXEL_B64="/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k="

echo "== POST /api/v1/reference-horse/photos (imagen de prueba, no real) =="
RESPONSE=$(curl -s -w "\nHTTP %{http_code}" "$API/api/v1/reference-horse/photos" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d "{\"dataBase64\":\"$PIXEL_B64\",\"mimeType\":\"image/jpeg\"}")
echo "$RESPONSE"

URL=$(echo "$RESPONSE" | head -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])" 2>/dev/null)
echo ""
echo "== GET de esa misma URL (confirmar que sirve la imagen real) =="
if [ -n "$URL" ]; then
  curl -s -o /dev/null -w "HTTP %{http_code} - Content-Type: %{content_type} - tamaño: %{size_download} bytes\n" "$URL"
else
  echo "No se pudo extraer la URL de la respuesta anterior."
fi

echo ""
echo "=================================="
echo "NOTA: esto NO se usó como caballo referente real (no se llamó a PUT /reference-horse)."
echo "=================================="
read -n 1 -s -r -p "Presiona una tecla para cerrar..."
