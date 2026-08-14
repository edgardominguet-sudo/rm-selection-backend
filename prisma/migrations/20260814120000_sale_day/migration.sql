-- CreateTable
CREATE TABLE "SaleDay" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "book" TEXT,
    "sessionNumber" INTEGER,
    "startTimeLabel" TEXT,
    "hipRangeStart" TEXT,
    "hipRangeEnd" TEXT,
    "headCount" INTEGER,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaleDay_saleId_date_key" ON "SaleDay"("saleId", "date");

-- AddForeignKey
ALTER TABLE "SaleDay" ADD CONSTRAINT "SaleDay_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
