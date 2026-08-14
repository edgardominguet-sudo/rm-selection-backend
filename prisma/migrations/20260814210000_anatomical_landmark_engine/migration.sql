-- MOTOR PROFESIONAL DE ANÁLISIS ANATÓMICO RM SELECTION (2026-08-14)
-- Columnas nuevas, aditivas — ninguna fila existente se toca ni se
-- reinterpreta (methodologyVersion sigue distinguiendo qué motor produjo
-- cada AnalysisResult).

-- AlterTable: calibración del caballo referente (landmarks ya extraídos
-- de sus 3 fotos, calculados una sola vez y reusados en cada análisis).
ALTER TABLE "ReferenceHorse" ADD COLUMN "calibrationJson" JSONB;
ALTER TABLE "ReferenceHorse" ADD COLUMN "calibrationHash" TEXT;
ALTER TABLE "ReferenceHorse" ADD COLUMN "calibratedAt" TIMESTAMP(3);

-- AlterTable: landmarks/hallazgos crudos por vista de cada análisis.
ALTER TABLE "AnalysisResult" ADD COLUMN "landmarksJson" JSONB;
ALTER TABLE "AnalysisResult" ADD COLUMN "findingsJson" JSONB;
