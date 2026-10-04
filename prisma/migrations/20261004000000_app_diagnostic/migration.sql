-- CreateTable
CREATE TABLE "AppDiagnostic" (
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

-- CreateIndex
CREATE INDEX "AppDiagnostic_createdAt_idx" ON "AppDiagnostic"("createdAt");
