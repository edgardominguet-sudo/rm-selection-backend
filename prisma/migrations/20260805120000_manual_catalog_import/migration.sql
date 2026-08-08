-- AlterEnum
-- No se puede USAR el valor nuevo dentro de la misma transacción en la que
-- se agrega (regla de Postgres) — esta migración solo lo agrega, no lo usa.
ALTER TYPE "SaleCatalogAccess" ADD VALUE 'MANUAL_CSV';

-- CreateTable
CREATE TABLE "CatalogImport" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "importedByUserId" TEXT,
    "fileName" TEXT,
    "rowCount" INTEGER NOT NULL,
    "hipsCreated" INTEGER NOT NULL,
    "hipsUpdated" INTEGER NOT NULL,
    "warningsJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogImport_saleId_createdAt_idx" ON "CatalogImport"("saleId", "createdAt");

-- AddForeignKey
ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_importedByUserId_fkey" FOREIGN KEY ("importedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
