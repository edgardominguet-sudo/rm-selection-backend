-- Reintentos acotados del análisis automático de fotos (2026-09-10, ver
-- analysis/autoPhotoAnalysis.ts regla 7) — cuántos intentos técnicos
-- fallaron consecutivamente para el mismo conjunto de fotos publicadas
-- de un Hip, y la huella de ese conjunto, para saber cuándo reintentar
-- de cero automáticamente. Columnas nuevas nullable/con default: ninguna
-- fila existente se ve afectada.
ALTER TABLE "Hip" ADD COLUMN "autoLateralPhotoFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Hip" ADD COLUMN "autoLateralPhotoLastAttemptedFingerprint" TEXT;
