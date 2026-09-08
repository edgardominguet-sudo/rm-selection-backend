-- Fecha de nacimiento COMPLETA del Hip ("foaling date", 2026-09-07, a
-- pedido explícito de Ramon: mostrar "Foaled: May 16, 2025" en el PDF de
-- Compartir Hip). Columna nullable: ninguna fila existente se ve afectada,
-- y el próximo resync de catálogo la completa sola en los Hips ya
-- guardados (mismo criterio que la migración hip_barn).
ALTER TABLE "Hip" ADD COLUMN "foalingDate" TIMESTAMP(3);
