#!/bin/bash
set -e
cd "/Users/ramonminguet/Downloads/RMSelection/backend"
echo "== Limpiando locks de git viejos =="
find .git -name "*.lock" -delete 2>/dev/null || true
echo "== git status =="
git status --short
echo "== git add + commit =="
git add -A
git commit -m "Tarea 1: fotos del caballo referente en Postgres (via alterna sin R2)

Agrega ReferenceHorsePhoto (Postgres, base64) + POST/GET
/api/v1/reference-horse/photos como via alternativa para hospedar las
fotos del caballo referente mientras el bucket de R2 no este
configurado. El analisis de IA server-side (analyzeHip) necesita URLs
reales para poder hacer fetch() de las fotos del referente -- esto le
da una fuente propia del backend, sin depender de ningun storage
externo ni credencial nueva.

config.publicBaseUrl agregado para construir esas URLs propias." || echo "(nada para commitear)"
echo "== git push =="
git push origin main
echo ""
echo "=================================="
echo "LISTO. Podes cerrar esta ventana."
echo "=================================="
read -n 1 -s -r -p "Presiona una tecla para cerrar..."
