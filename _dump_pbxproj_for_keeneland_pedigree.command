#!/bin/bash
set -e
PROJROOT="/Users/ramonminguet/Downloads/RMSelection"
echo "=== buscando .xcodeproj ==="
find "$PROJROOT" -maxdepth 2 -iname "*.xcodeproj"
XPROJ=$(find "$PROJROOT" -maxdepth 2 -iname "*.xcodeproj" | head -1)
echo "=== usando: $XPROJ ==="
PBX="$XPROJ/project.pbxproj"
cp "$PBX" "$PROJROOT/backend/_pbxproj_dump.txt"
echo "=== copiado a backend/_pbxproj_dump.txt (tamano: $(wc -l < "$PBX") lineas) ==="
echo "==== listo, presiona Enter para cerrar ===="
read
