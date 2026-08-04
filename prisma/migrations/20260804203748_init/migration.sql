-- CreateEnum
CREATE TYPE "SaleHouse" AS ENUM ('FASIG_TIPTON', 'KEENELAND', 'OBS');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'BUYER');

-- CreateEnum
CREATE TYPE "ObservationCategory" AS ENUM ('CONFORMATION', 'MOVEMENT', 'PEDIGREE', 'GENERAL');

-- CreateEnum
CREATE TYPE "SaleCatalogAccess" AS ENUM ('FULL', 'PENDING_ID', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "SaleAlertKind" AS ENUM ('NEW_SALE_DETECTED', 'SYNC_STARTED', 'CATALOG_NOW_AVAILABLE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT,
    "apiKey" TEXT,
    "displayName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceName" TEXT,
    "appVersion" TEXT,
    "pushToken" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "house" "SaleHouse" NOT NULL,
    "name" TEXT NOT NULL,
    "externalSaleId" TEXT NOT NULL,
    "scheduleYear" INTEGER,
    "scheduleSlug" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCatalogCheckAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3),
    "announcementUrl" TEXT,
    "catalogAccess" "SaleCatalogAccess" NOT NULL DEFAULT 'FULL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleAlert" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" "SaleAlertKind" NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hip" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "hipNumber" TEXT NOT NULL,
    "horseName" TEXT,
    "sex" TEXT,
    "consignor" TEXT,
    "sire" TEXT,
    "dam" TEXT,
    "damSire" TEXT,
    "sessionDate" TIMESTAMP(3),
    "mediaJson" JSONB NOT NULL DEFAULT '[]',
    "saleResultJson" JSONB,
    "lastCatalogSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "triggerReason" TEXT NOT NULL DEFAULT 'initial',
    "mediaHash" TEXT,
    "conformationScoresJson" JSONB NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "classification" TEXT NOT NULL,
    "summary" TEXT,
    "gaitFrameCount" INTEGER,
    "gaitVideoDurationSec" DOUBLE PRECISION,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,

    CONSTRAINT "AnalysisResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrentHipAnalysis" (
    "id" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "analysisResultId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentHipAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "deviceId" TEXT,
    "finalCall" TEXT NOT NULL,
    "notes" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UserDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HipObservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "deviceId" TEXT,
    "text" TEXT NOT NULL,
    "category" "ObservationCategory",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HipObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankingSnapshot" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "entriesJson" JSONB NOT NULL,
    "totalHipsToday" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankingSnapshotVersion" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "entriesJson" JSONB NOT NULL,
    "totalHipsToday" INTEGER NOT NULL,
    "triggerReason" TEXT NOT NULL DEFAULT 'initial',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankingSnapshotVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulerRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "salesProcessed" INTEGER NOT NULL DEFAULT 0,
    "analysesRun" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SchedulerRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceHorse" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'default',
    "photoUrls" JSONB NOT NULL DEFAULT '[]',
    "gaitVideoUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceHorse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_apiKey_key" ON "User"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_house_externalSaleId_key" ON "Sale"("house", "externalSaleId");

-- CreateIndex
CREATE INDEX "SaleAlert_createdAt_idx" ON "SaleAlert"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Hip_saleId_hipNumber_key" ON "Hip"("saleId", "hipNumber");

-- CreateIndex
CREATE INDEX "Hip_saleId_sessionDate_idx" ON "Hip"("saleId", "sessionDate");

-- CreateIndex
CREATE INDEX "AnalysisResult_overallScore_idx" ON "AnalysisResult"("overallScore");

-- CreateIndex
CREATE INDEX "AnalysisResult_hipId_analyzedAt_idx" ON "AnalysisResult"("hipId", "analyzedAt");

-- CreateIndex
CREATE INDEX "AnalysisResult_organizationId_hipId_analyzedAt_idx" ON "AnalysisResult"("organizationId", "hipId", "analyzedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentHipAnalysis_hipId_organizationId_key" ON "CurrentHipAnalysis"("hipId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDecision_userId_hipId_key" ON "UserDecision"("userId", "hipId");

-- CreateIndex
CREATE INDEX "HipObservation_userId_hipId_idx" ON "HipObservation"("userId", "hipId");

-- CreateIndex
CREATE UNIQUE INDEX "RankingSnapshot_organizationId_saleId_sessionDate_key" ON "RankingSnapshot"("organizationId", "saleId", "sessionDate");

-- CreateIndex
CREATE INDEX "RankingSnapshotVersion_organizationId_saleId_sessionDate_generatedAt_idx" ON "RankingSnapshotVersion"("organizationId", "saleId", "sessionDate", "generatedAt");

-- CreateIndex
CREATE INDEX "SchedulerRun_startedAt_idx" ON "SchedulerRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceHorse_organizationId_key_key" ON "ReferenceHorse"("organizationId", "key");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAlert" ADD CONSTRAINT "SaleAlert_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hip" ADD CONSTRAINT "Hip_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisResult" ADD CONSTRAINT "AnalysisResult_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisResult" ADD CONSTRAINT "AnalysisResult_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentHipAnalysis" ADD CONSTRAINT "CurrentHipAnalysis_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentHipAnalysis" ADD CONSTRAINT "CurrentHipAnalysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentHipAnalysis" ADD CONSTRAINT "CurrentHipAnalysis_analysisResultId_fkey" FOREIGN KEY ("analysisResultId") REFERENCES "AnalysisResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDecision" ADD CONSTRAINT "UserDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDecision" ADD CONSTRAINT "UserDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDecision" ADD CONSTRAINT "UserDecision_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDecision" ADD CONSTRAINT "UserDecision_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HipObservation" ADD CONSTRAINT "HipObservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HipObservation" ADD CONSTRAINT "HipObservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HipObservation" ADD CONSTRAINT "HipObservation_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HipObservation" ADD CONSTRAINT "HipObservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankingSnapshot" ADD CONSTRAINT "RankingSnapshot_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankingSnapshot" ADD CONSTRAINT "RankingSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankingSnapshotVersion" ADD CONSTRAINT "RankingSnapshotVersion_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankingSnapshotVersion" ADD CONSTRAINT "RankingSnapshotVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceHorse" ADD CONSTRAINT "ReferenceHorse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
