-- Control de versión del referente por vista de AnalysisResult (ver
-- comentario en schema.prisma) — permite invalidar automáticamente una
-- vista "estable" cuando el caballo referente (o ENGINE_FORMULA_VERSION)
-- cambia, sin depender de fecha ni de un número de versión manual.
ALTER TABLE "AnalysisResult" ADD COLUMN "viewReferenceHashJson" JSONB;
