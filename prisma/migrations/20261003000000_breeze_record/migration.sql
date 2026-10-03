-- MADRES VELOCISTAS (2026-10-02): trabajos oficiales de ventas de 2 años.
CREATE TABLE "BreezeRecord" (
    "id" TEXT NOT NULL,
    "house" "SaleHouse" NOT NULL,
    "externalSaleId" TEXT NOT NULL,
    "saleName" TEXT NOT NULL,
    "saleYear" INTEGER NOT NULL,
    "hipNumber" TEXT NOT NULL,
    "horseName" TEXT,
    "nameKey" TEXT,
    "sex" TEXT,
    "sire" TEXT,
    "sireKey" TEXT,
    "dam" TEXT,
    "damKey" TEXT,
    "damSire" TEXT,
    "damSireKey" TEXT,
    "foalYear" INTEGER,
    "consignor" TEXT,
    "distance" TEXT NOT NULL,
    "timeRaw" TEXT NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL,
    "isElite" BOOLEAN NOT NULL,
    "rankInSale" INTEGER NOT NULL,
    "fieldSize" INTEGER NOT NULL,
    "workDate" TIMESTAMP(3),
    "priceRaw" TEXT,
    "purchaser" TEXT,
    "resultCode" TEXT,
    "videoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BreezeRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BreezeRecord_house_externalSaleId_hipNumber_key" ON "BreezeRecord"("house", "externalSaleId", "hipNumber");
CREATE INDEX "BreezeRecord_damKey_idx" ON "BreezeRecord"("damKey");
CREATE INDEX "BreezeRecord_nameKey_idx" ON "BreezeRecord"("nameKey");
