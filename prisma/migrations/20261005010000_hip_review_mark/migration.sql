-- CreateTable
CREATE TABLE "HipReviewMark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "house" TEXT NOT NULL,
    "externalSaleId" TEXT NOT NULL,
    "hipNumber" TEXT NOT NULL,
    "reviewed" BOOLEAN NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HipReviewMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HipReviewMark_userId_house_externalSaleId_hipNumber_key" ON "HipReviewMark"("userId", "house", "externalSaleId", "hipNumber");

-- CreateIndex
CREATE INDEX "HipReviewMark_userId_updatedAt_idx" ON "HipReviewMark"("userId", "updatedAt");
