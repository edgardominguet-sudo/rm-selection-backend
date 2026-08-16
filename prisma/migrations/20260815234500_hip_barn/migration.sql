-- Campo Barn permanente para Hip (2026-08-15, TAREA 2: corrección
-- estructural — Barn es un dato del establo dentro de la VENTA, presente
-- en Fasig-Tipton, Keeneland y el import manual (OBS), que se había
-- perdido al generalizar el importador por casa (task #150) porque nunca
-- se declaró en el contrato compartido NormalizedHip. Columna nullable:
-- ninguna fila existente se ve afectada, y el próximo re-sync de catálogo
-- completa Barn automáticamente en los Hips ya guardados (incluidos los
-- ya marcados como favoritos), sin necesidad de backfill manual aparte.
ALTER TABLE "Hip" ADD COLUMN "barn" TEXT;
