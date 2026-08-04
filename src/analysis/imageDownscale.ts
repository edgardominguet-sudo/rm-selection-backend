import sharp from "sharp";

// Puerto de RMSelection/Utilities/ImageDownscaler.swift: reescala a un
// máximo de 1024px de lado más largo y recomprime a JPEG calidad 0.7,
// para no mandar fotos pesadas a la API de Anthropic (evita timeouts/502
// con payloads grandes).
export async function downscaleToJPEG(data: Buffer, maxDimension = 1024, quality = 70): Promise<Buffer | null> {
  try {
    return await sharp(data)
      .rotate() // respeta la orientación EXIF, igual que UIImage
      .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  } catch {
    return null;
  }
}

export async function fetchAndDownscale(url: string, maxDimension = 1024, quality = 70): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return downscaleToJPEG(buffer, maxDimension, quality);
  } catch {
    return null;
  }
}
