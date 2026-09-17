-- AlterTable: el análisis IA automático pasa a ser 100% manual por
-- defecto para TODA venta nueva (pedido explícito de Ramon, 2026-09-17).
ALTER TABLE "Sale" ALTER COLUMN "autoAiAnalysisEnabled" SET DEFAULT false;

-- Data migration: análisis IA 100% manual para TODAS las ventas
-- existentes, sin excepción (antes solo se había apagado caso por caso
-- para 4 de las 6 ventas cargadas -- quedaban "Fasig-Tipton — Saratoga"
-- y "The Saratoga Sale" con el valor default viejo, true).
UPDATE "Sale" SET "autoAiAnalysisEnabled" = false;
