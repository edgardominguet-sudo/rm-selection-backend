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

/**
 * Quita la franja blanca con la leyenda que algunas fotos del catálogo
 * traen pegada abajo (2026-10-17, Fasig-Tipton Hip 1389). Mismo criterio
 * conservador que `CatalogCaptionTrimmer` en la app: bloque continuo de
 * filas casi blancas desde abajo (con el texto de la leyenda), de 3–30 %
 * del alto, con la foto real empezando justo encima. Si no se cumple, devuelve la imagen intacta.
 */
export async function trimCatalogCaption(data: Buffer): Promise<Buffer> {
  try {
    const upright = await sharp(data).rotate().toBuffer();
    const meta = await sharp(upright).metadata();
    if (!meta.width || !meta.height) return data;
    const width = 160;
    const { data: px, info } = await sharp(upright).greyscale().resize({ width }).raw().toBuffer({ resolveWithObject: true });
    const height = info.height;
    const rowWidth = info.width * info.channels;
    const whiteFraction = (row: number) => {
      let count = 0;
      for (let x = 0; x < info.width; x++) if (px[row * rowWidth + x * info.channels] >= 225) count++;
      return count / info.width;
    };
    let row = height - 1;
    // Filas de la franja: ≥ 60 % blancas cada una (las del texto bajan a
    // ~75 %) y ≥ 80 % en promedio; la foto real casi no tiene blancos.
    let sum = 0;
    while (row >= 0 && whiteFraction(row) >= 0.6) { sum += whiteFraction(row); row--; }
    const band = height - 1 - row;
    if (row < 0 || band < height * 0.03 || band > height * 0.3 || sum / band < 0.8 || whiteFraction(row) >= 0.3) return data;
    const keep = Math.floor(meta.height * (1 - band / height - 0.01));
    if (keep <= meta.height / 2) return data;
    return await sharp(upright).extract({ left: 0, top: 0, width: meta.width, height: keep }).toBuffer();
  } catch {
    return data;
  }
}

export async function fetchAndDownscale(url: string, maxDimension = 1024, quality = 70): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await trimCatalogCaption(Buffer.from(await response.arrayBuffer()));
    return downscaleToJPEG(buffer, maxDimension, quality);
  } catch {
    return null;
  }
}
