-- CreateTable
CREATE TABLE "RecentHipVisit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hipId" TEXT NOT NULL,
    "deviceId" TEXT,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecentHipVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecentHipVisit_userId_hipId_key" ON "RecentHipVisit"("userId", "hipId");

-- AddForeignKey
ALTER TABLE "RecentHipVisit" ADD CONSTRAINT "RecentHipVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentHipVisit" ADD CONSTRAINT "RecentHipVisit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentHipVisit" ADD CONSTRAINT "RecentHipVisit_hipId_fkey" FOREIGN KEY ("hipId") REFERENCES "Hip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentHipVisit" ADD CONSTRAINT "RecentHipVisit_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
