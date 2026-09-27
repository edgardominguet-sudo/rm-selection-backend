-- Search por venta (2026-09-27): padre de cada padrillo, para el filtro Grand Sire.
-- Columna nullable: no modifica ningún dato existente.
ALTER TABLE "Stallion" ADD COLUMN "sireName" TEXT;
