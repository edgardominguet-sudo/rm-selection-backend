-- CreateEnum
CREATE TYPE "AnalysisSource" AS ENUM ('AI', 'MANUAL');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO', 'VET_REPORT', 'PEDIGREE_CHART');

-- CreateEnum
CREATE TYPE "MediaUploadStatus" AS ENUM ('PENDING_UPLOAD', 'PROCESSED', 'FAILED');

-- AlterTable
-- Puntaje manual (sincronización multidispositivo, 2026-08-08): un análisis
-- ahora puede venir de IA o cargarse a mano desde cualquier dispositivo.
-- source default AI preserva el significado de todas las filas existentes.
ALTER TABLE "AnalysisResult" ADD COLUMN     "source" "AnalysisSource" NOT NULL DEFAULT 'AI',
ADD COLUMN     "enteredByUserId" TEXT,
ADD COLUMN     "deviceId" TEXT;

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "deviceId" TEXT,
    "kind" "MediaKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT,
    "byteSize" INTEGER,
    "uploadStatus" "MediaUploadStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VetReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "deviceId" TEXT,
    "mediaAssetId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VetReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAsset_userId_hipId_idx" ON "MediaAsset"("userId", "hipId");

-- CreateIndex
CREATE INDEX "MediaAsset_hipId_kind_idx" ON "MediaAsset"("hipId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "VetReport_mediaAssetId_key" ON "VetReport"("mediaAssetId");

-- CreateIndex
CREATE INDEX "VetReport_userId_hipId_idx" ON "VetReport"("userId", "hipId");

-- CreateIndex
CREATE INDEX "VetReport_hipId_idx" ON "VetReport"("hipId");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VetReport" ADD CONSTRAINT "VetReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VetReport" ADD CONSTRAINT "VetReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VetReport" ADD CONSTRAINT "VetReport_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VetReport" ADD CONSTRAINT "VetReport_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VetReport" ADD CONSTRAINT "VetReport_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
