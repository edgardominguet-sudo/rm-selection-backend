-- AlterTable: agrega viewSourceAssetIdsJson a AnalysisResult — permite
-- reusar el resultado de una vista (frontal/lateral/posterior) sin volver
-- a llamar a la IA cuando su foto no cambió, aunque las otras vistas del
-- mismo Hip sí hayan cambiado. Ver comentario completo en schema.prisma.
ALTER TABLE "AnalysisResult" ADD COLUMN "viewSourceAssetIdsJson" JSONB;
