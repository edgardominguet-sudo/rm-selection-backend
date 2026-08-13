#!/bin/bash
cd "/Users/ramonminguet/Downloads/RMSelection/backend" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "Pedigree: sincronizacion multidispositivo de anotaciones (PedigreeAnnotation)"
git push origin main
echo ""
echo "==== listo, presiona Enter para cerrar ===="
read
