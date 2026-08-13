-- CreateEnum
CREATE TYPE "OfficialSaleResultCode" AS ENUM ('SOLD', 'RNA', 'SCRATCHED', 'OTHER');

-- CreateTable
CREATE TABLE "OfficialSaleResult" (
    "id" TEXT NOT NULL,
    "saleHouse" "SaleHouse",
    "saleHouseLabel" TEXT,
    "saleName" TEXT NOT NULL,
    "saleYear" INTEGER NOT NULL,
    "hipNumber" TEXT NOT NULL,
    "horseName" TEXT,
    "sire" TEXT,
    "dam" TEXT,
    "consignor" TEXT,
    "priceRaw" TEXT,
    "resultCode" TEXT,
    "purchaser" TEXT,
    "sourceHipId" TEXT,
    "firstRecordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialSaleResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficialSaleResult_sire_dam_idx" ON "OfficialSaleResult"("sire", "dam");

-- CreateIndex
CREATE INDEX "OfficialSaleResult_saleYear_saleHouse_idx" ON "OfficialSaleResult"("saleYear", "saleHouse");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialSaleResult_saleHouse_saleName_saleYear_hipNumber_key" ON "OfficialSaleResult"("saleHouse", "saleName", "saleYear", "hipNumber");

-- AddForeignKey
ALTER TABLE "OfficialSaleResult" ADD CONSTRAINT "OfficialSaleResult_sourceHipId_fkey" FOREIGN KEY ("sourceHipId") REFERENCES "Hip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
