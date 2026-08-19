-- Tabla nueva e independiente para padrillos (2026-08-19, "Padrillos de
-- primera generación de yearlings 2026") — ver comentario completo junto
-- al modelo Stallion en schema.prisma. No depende de ninguna Organization
-- ni de ningún Hip/venta puntual: es un dato objetivo del sector
-- (industry-wide), válido para cualquier venta/año que la app consulte.
CREATE TABLE "Stallion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstYearlingsYear" INTEGER,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stallion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Stallion_name_key" ON "Stallion"("name");

CREATE INDEX "Stallion_firstYearlingsYear_idx" ON "Stallion"("firstYearlingsYear");
