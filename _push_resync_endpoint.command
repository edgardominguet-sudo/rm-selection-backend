#!/bin/bash
cd /Users/ramonminguet/Downloads/RMSelection/backend || exit 1
echo "=== git status ==="
git status --short
echo "=== git log -3 ==="
git log --oneline -3
echo "=== git push origin main ==="
git push origin main 2>&1
echo "=== FIN ==="
echo "Presiona Enter para cerrar..."
read
