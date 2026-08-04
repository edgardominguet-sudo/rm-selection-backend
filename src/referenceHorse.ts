import { db } from "./db";
import { ReferenceHorseAssets } from "./analysis/anthropicClient";

/**
 * Lee la configuración del caballo referente del Método RM (fotos + video
 * de marcha opcional) desde la base — reemplaza a ReferenceHorseStore.swift,
 * que guardaba esto por dispositivo. Acá se configura por ORGANIZACIÓN
 * (cada una puede tener su propio patrón oficial y por lo tanto llegar a
 * puntajes distintos sobre el mismo catálogo), y todos los análisis de esa
 * organización lo usan por igual.
 */
export async function getReferenceHorse(organizationId: string): Promise<ReferenceHorseAssets> {
  const row = await db.referenceHorse.findUnique({ where: { organizationId_key: { organizationId, key: "default" } } });
  if (!row) return { photoUrls: [], gaitVideoUrl: null };
  return {
    photoUrls: (row.photoUrls as string[]) ?? [],
    gaitVideoUrl: row.gaitVideoUrl,
  };
}

export async function setReferenceHorse(organizationId: string, assets: ReferenceHorseAssets): Promise<void> {
  await db.referenceHorse.upsert({
    where: { organizationId_key: { organizationId, key: "default" } },
    create: { organizationId, key: "default", photoUrls: assets.photoUrls, gaitVideoUrl: assets.gaitVideoUrl ?? null },
    update: { photoUrls: assets.photoUrls, gaitVideoUrl: assets.gaitVideoUrl ?? null },
  });
}
