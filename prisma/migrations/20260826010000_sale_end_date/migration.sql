-- Último día calendario de la venta (ver comentario en Sale.endDate,
-- schema.prisma) — 2026-08-26, selector de ventas 100% dinámico.
ALTER TABLE "Sale" ADD COLUMN "endDate" TIMESTAMP(3);
