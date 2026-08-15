#!/bin/bash
set -e
PROJROOT="/Users/ramonminguet/Downloads/RMSelection"
XPROJ=$(find "$PROJROOT" -maxdepth 2 -iname "*.xcodeproj" | head -1)
PBX="$XPROJ/project.pbxproj"
PATCHED="$PROJROOT/backend/_pbxproj_dump.txt"
BACKUP="$PROJROOT/backend/_pbxproj_backup_before_catalogmediadailysync_$(date +%Y%m%d_%H%M%S).txt"

echo "=== usando: $XPROJ ==="
echo "=== respaldando pbxproj actual en: $BACKUP ==="
cp "$PBX" "$BACKUP"

echo "=== verificando que el patch tenga las 4 referencias esperadas ==="
COUNT=$(grep -c "CatalogMediaDailySync" "$PATCHED")
echo "Ocurrencias de CatalogMediaDailySync en el patch: $COUNT"
if [ "$COUNT" -ne 4 ]; then
  echo "!!! ABORTANDO: se esperaban 4 ocurrencias, se encontraron $COUNT. No se toca el pbxproj real. !!!"
  echo "==== presiona Enter para cerrar ===="
  read
  exit 1
fi

echo "=== copiando patch sobre el pbxproj real ==="
cp "$PATCHED" "$PBX"
echo "=== listo. Respaldo guardado en $BACKUP por si hace falta revertir. ==="
echo "==== presiona Enter para cerrar ===="
read
