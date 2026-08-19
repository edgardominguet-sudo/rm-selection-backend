-- Caché de extracción de landmarks por foto (2026-08-19, bug real
-- reportado por Ramon: "para la misma foto analizada en 3 oportunidades la
-- IA dio tres resultados diferentes") — ver comentario completo junto al
-- modelo LandmarkExtractionCache en schema.prisma. Tabla nueva e
-- independiente, no depende de ninguna Organization/Hip puntual: es un
-- caché puro por bytes de imagen, válido para cualquier foto que pase por
-- el motor de extracción de landmarks.
CREATE TABLE "LandmarkExtractionCache" (
    "id" TEXT NOT NULL,
    "photoHash" TEXT NOT NULL,
    "expectedView" TEXT NOT NULL DEFAULT '',
    "promptVersion" TEXT NOT NULL,
    "landmarksJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandmarkExtractionCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LandmarkExtractionCache_photoHash_expectedView_promptVersi_key" ON "LandmarkExtractionCache"("photoHash", "expectedView", "promptVersion");
