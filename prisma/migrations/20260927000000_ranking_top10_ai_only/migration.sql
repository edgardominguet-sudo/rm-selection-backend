-- Ranking del Día: Top 10 real basado exclusivamente en análisis IA
-- (2026-09-26, pedido explícito de Ramon). Cuántos Hips de la jornada
-- tienen un análisis IA válido para el ranking -- lo calcula
-- rebuildRankingSnapshot (rankingService.ts) en cada regeneración.
ALTER TABLE "RankingSnapshot" ADD COLUMN "analyzedHipsToday" INTEGER NOT NULL DEFAULT 0;
