-- CreateTable
CREATE TABLE "ReferenceHorsePhoto" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "dataBase64" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceHorsePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceHorsePhoto_organizationId_idx" ON "ReferenceHorsePhoto"("organizationId");

-- AddForeignKey
ALTER TABLE "ReferenceHorsePhoto" ADD CONSTRAINT "ReferenceHorsePhoto_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
