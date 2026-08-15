-- Registro persistido de cada corrida del barrido de Media (2026-08-15,
-- a pedido de Ramon: "implementa persistencia del estado de
-- sincronizacion"). Tabla nueva, no toca ninguna existente.

CREATE TABLE "MediaSweepRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "salesChecked" INTEGER NOT NULL DEFAULT 0,
    "salesSkipped" INTEGER NOT NULL DEFAULT 0,
    "hipsReviewed" INTEGER NOT NULL DEFAULT 0,
    "hipsWithNewMedia" INTEGER NOT NULL DEFAULT 0,
    "resourcesFound" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "detailsJson" JSONB,

    CONSTRAINT "MediaSweepRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MediaSweepRun_startedAt_idx" ON "MediaSweepRun"("startedAt");
