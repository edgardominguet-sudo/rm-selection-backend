-- Search por venta (2026-09-28): columnas nuevas, todas nullable.
-- No modifica ningún dato existente; se completan en la próxima
-- sincronización de catálogo de cada venta activa/próxima.
ALTER TABLE "Hip" ADD COLUMN "bredState" TEXT;
ALTER TABLE "Hip" ADD COLUMN "consignorBase" TEXT;
ALTER TABLE "Stallion" ADD COLUMN "sireNameSource" TEXT;
