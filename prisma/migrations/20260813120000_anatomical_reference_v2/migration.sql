-- AlterTable: nuevo patrón anatómico del caballo referente (3 vistas fijas)
ALTER TABLE "ReferenceHorse" ADD COLUMN "lateralPhotoUrl" TEXT;
ALTER TABLE "ReferenceHorse" ADD COLUMN "frontalPhotoUrl" TEXT;
ALTER TABLE "ReferenceHorse" ADD COLUMN "posteriorPhotoUrl" TEXT;

-- AlterTable: nueva metodología de Análisis (IA) — anatomía comparativa,
-- 3 vistas x 3 parámetros, sin Marcha. Nullable a propósito: filas ya
-- existentes quedan con methodologyVersion = NULL (metodología legado) y
-- photoClassificationsJson = NULL, nunca se reescriben.
ALTER TABLE "AnalysisResult" ADD COLUMN "methodologyVersion" TEXT;
ALTER TABLE "AnalysisResult" ADD COLUMN "photoClassificationsJson" JSONB;
