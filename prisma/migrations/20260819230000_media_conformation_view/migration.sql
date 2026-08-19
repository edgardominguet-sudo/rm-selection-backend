-- AlterTable: agrega conformationView (frontal/lateral/posterior) a
-- MediaAsset — solo aplica a AI_ANALYSIS_PHOTO, nullable para todo lo demás.
-- Ver comentario completo en schema.prisma (model MediaAsset).
ALTER TABLE "MediaAsset" ADD COLUMN "conformationView" TEXT;
