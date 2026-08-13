#!/bin/bash
cd /Users/ramonminguet/Downloads/RMSelection/backend || exit 1
echo "=== removing stale HEAD.lock if present ==="
rm -f .git/HEAD.lock
echo "=== git add -A ==="
git add -A
echo "=== git commit ==="
git commit -m "Agregar variante GET /sales/resync (navegable desde browser, sin POST/body)"
echo "=== git push origin main ==="
git push origin main 2>&1
echo "=== cleanup temp scripts ==="
rm -f _push_resync_endpoint.command
rm -f _fix_gitlock_and_push.command
echo "=== FIN ==="
echo "Presiona Enter para cerrar..."
read
