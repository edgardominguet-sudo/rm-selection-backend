-- AlterEnum: nuevo tipo de MediaAsset para las fotos tomadas EXCLUSIVAMENTE
-- desde la pantalla Análisis (IA) — separa por completo esas fotos de
-- Media/catálogo, que nunca deben alimentar el motor de análisis (regla
-- dura del Método RM, 2026-08-13). Adición pura al enum: no toca filas
-- existentes.
ALTER TYPE "MediaKind" ADD VALUE 'AI_ANALYSIS_PHOTO';
