-- Historial de corridas del RECÁLCULO COMPLETO tras cambiar el caballo
-- referente (ver comentario en schema.prisma, ReferenceRecalcRun) — mismo
-- patrón que MediaSweepRun.
CREATE TABLE "ReferenceRecalcRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'running',
    "hipsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "reanalyzed" INTEGER NOT NULL DEFAULT 0,
    "reused" INTEGER NOT NULL DEFAULT 0,
    "noReference" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "detailsJson" JSONB,

    CONSTRAINT "ReferenceRecalcRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferenceRecalcRun_startedAt_idx" ON "ReferenceRecalcRun"("startedAt");
