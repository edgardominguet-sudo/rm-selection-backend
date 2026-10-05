-- CreateTable
CREATE TABLE "AppEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "house" TEXT,
    "externalSaleId" TEXT,
    "hipNumber" TEXT,
    "targetHouse" TEXT,
    "targetExternalSaleId" TEXT,
    "targetHipNumber" TEXT,
    "hips" JSONB,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),

    CONSTRAINT "AppEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppEvent_dedupeKey_key" ON "AppEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "AppEvent_createdAt_idx" ON "AppEvent"("createdAt");
