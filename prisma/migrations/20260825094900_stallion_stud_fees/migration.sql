-- Stud Fee 2024/2026 + granja actual en Stallion (2026-08-25, a pedido
-- explícito de Ramon: mostrar el fee junto al padrillo en "Buscar
-- padrillo/madre"). Todo TEXTO libre (nunca numérico forzado) — ver
-- comentario completo junto al modelo Stallion en schema.prisma.
ALTER TABLE "Stallion" ADD COLUMN "studFee2024" TEXT;
ALTER TABLE "Stallion" ADD COLUMN "studFee2026" TEXT;
ALTER TABLE "Stallion" ADD COLUMN "studFeeSource2024" TEXT;
ALTER TABLE "Stallion" ADD COLUMN "studFeeSource2026" TEXT;
ALTER TABLE "Stallion" ADD COLUMN "currentFarm" TEXT;
