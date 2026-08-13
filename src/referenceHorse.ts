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
  if (!row) return { photoUrls: [], gaitVideoUrl: null, lateralPhotoUrl: null, frontalPhotoUrl: null, posteriorPhotoUrl: null };
  return {
    photoUrls: (row.photoUrls as string[]) ?? [],
    gaitVideoUrl: row.gaitVideoUrl,
    lateralPhotoUrl: row.lateralPhotoUrl,
    frontalPhotoUrl: row.frontalPhotoUrl,
    posteriorPhotoUrl: row.posteriorPhotoUrl,
  };
}

export async function setReferenceHorse(organizationId: string, assets: Partial<ReferenceHorseAssets>): Promise<void> {
  // Partial a propósito: PUT /reference-horse puede mandar solo las 3 vistas
  // nuevas sin tocar photoUrls/gaitVideoUrl legado, o viceversa — cada campo
  // ausente en el body deja el valor existente sin modificar (undefined en
  // Prisma update = "no tocar esta columna").
  const existing = await db.referenceHorse.findUnique({ where: { organizationId_key: { organizationId, key: "default" } } });
  await db.referenceHorse.upsert({
    where: { organizationId_key: { organizationId, key: "default" } },
    create: {
      organizationId,
      key: "default",
      photoUrls: assets.photoUrls ?? [],
      gaitVideoUrl: assets.gaitVideoUrl ?? null,
      lateralPhotoUrl: assets.lateralPhotoUrl ?? null,
      frontalPhotoUrl: assets.frontalPhotoUrl ?? null,
      posteriorPhotoUrl: assets.posteriorPhotoUrl ?? null,
    },
    update: {
      photoUrls: assets.photoUrls ?? existing?.photoUrls ?? [],
      gaitVideoUrl: assets.gaitVideoUrl !== undefined ? assets.gaitVideoUrl : existing?.gaitVideoUrl ?? null,
      lateralPhotoUrl: assets.lateralPhotoUrl !== undefined ? assets.lateralPhotoUrl : existing?.lateralPhotoUrl ?? null,
      frontalPhotoUrl: assets.frontalPhotoUrl !== undefined ? assets.frontalPhotoUrl : existing?.frontalPhotoUrl ?? null,
      posteriorPhotoUrl: assets.posteriorPhotoUrl !== undefined ? assets.posteriorPhotoUrl : existing?.posteriorPhotoUrl ?? null,
    },
  });
}
