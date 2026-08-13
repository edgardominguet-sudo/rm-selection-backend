-- CreateTable
CREATE TABLE "PedigreeAnnotation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "deviceId" TEXT,
    "drawingData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PedigreeAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PedigreeAnnotation_userId_hipId_key" ON "PedigreeAnnotation"("userId", "hipId");

-- AddForeignKey
ALTER TABLE "PedigreeAnnotation" ADD CONSTRAINT "PedigreeAnnotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedigreeAnnotation" ADD CONSTRAINT "PedigreeAnnotation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedigreeAnnotation" ADD CONSTRAINT "PedigreeAnnotation_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedigreeAnnotation" ADD CONSTRAINT "PedigreeAnnotation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
