-- CreateEnum
CREATE TYPE "SaleHistorySource" AS ENUM ('INTERNAL_HIP', 'CATALOG_NOTE', 'MANUAL', 'LICENSED_LOOKUP');

-- CreateEnum
CREATE TYPE "SaleHistoryVerification" AS ENUM ('CONFIRMED', 'LIKELY', 'UNVERIFIED');

-- AlterTable
ALTER TABLE "Hip" ADD COLUMN "breeder" TEXT,
ADD COLUMN "foalYear" INTEGER,
ADD COLUMN "color" TEXT;

-- CreateTable
CREATE TABLE "HorseSaleHistory" (
    "id" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "sourceHipId" TEXT,
    "saleHouse" "SaleHouse",
    "saleHouseLabel" TEXT,
    "saleName" TEXT NOT NULL,
    "saleYear" INTEGER NOT NULL,
    "hipNumberAtSale" TEXT,
    "priceRaw" TEXT,
    "resultCode" TEXT,
    "purchaser" TEXT,
    "source" "SaleHistorySource" NOT NULL,
    "verification" "SaleHistoryVerification" NOT NULL,
    "matchBasis" JSONB,
    "queriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HorseSaleHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HorseSaleHistory_hipId_idx" ON "HorseSaleHistory"("hipId");

-- CreateIndex
CREATE UNIQUE INDEX "HorseSaleHistory_hipId_saleHouse_saleYear_hipNumberAtSale_key" ON "HorseSaleHistory"("hipId", "saleHouse", "saleYear", "hipNumberAtSale");

-- AddForeignKey
ALTER TABLE "HorseSaleHistory" ADD CONSTRAINT "HorseSaleHistory_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HorseSaleHistory" ADD CONSTRAINT "HorseSaleHistory_sourceHipId_fkey" FOREIGN KEY ("sourceHipId") REFERENCES "Hip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
