-- Análisis automático y silencioso de video (2026-09-10, a pedido
-- explícito de Ramon): guarda qué video de catálogo (URL normalizada) ya
-- se convirtió en el fotograma de la tarjeta LATERAL de Análisis IA, para
-- no reprocesar el mismo video una y otra vez. Columna nullable: ninguna
-- fila existente se ve afectada.
ALTER TABLE "Hip" ADD COLUMN "autoVideoFrameSourceUrl" TEXT;
