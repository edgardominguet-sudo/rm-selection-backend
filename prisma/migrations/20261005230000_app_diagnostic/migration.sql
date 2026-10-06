-- Tabla de informes de cierres (MetricKit). El modelo AppDiagnostic estaba en
-- schema.prisma desde el 2026-10-04 pero nunca tuvo migración: cada envío
-- desde el iPhone/iPad fallaba con 500 y el informe completo (pila de
-- llamadas) nunca se guardaba.
CREATE TABLE IF NOT EXISTS "AppDiagnostic" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "device" TEXT,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "summary" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "AppDiagnostic_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppDiagnostic_createdAt_idx" ON "AppDiagnostic"("createdAt");
