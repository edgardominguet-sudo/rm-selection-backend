// Cliente de almacenamiento de objetos (Cloudflare R2, API compatible con
// S3) para los medios que el usuario carga desde la app: fotos/videos
// propios y fotos de reporte veterinario — sincronización
// multidispositivo, 2026-08-08. Antes de esto, esos archivos vivían SOLO
// en el Documents local del dispositivo que los capturó, por eso no
// aparecían en los demás dispositivos de la misma cuenta.
//
// Flujo de subida en dos fases (nunca pasa el archivo por este servidor,
// solo genera URLs firmadas):
//   1. POST /me/media → crea el MediaAsset (PENDING_UPLOAD) y devuelve una
//      URL PUT firmada.
//   2. El dispositivo sube el archivo DIRECTO a esa URL.
//   3. PUT /me/media/:id/confirm → pasa el registro a PROCESSED.
//
// Implementación propia de la firma AWS Signature V4 (presigned URL, query
// string) en vez de instalar @aws-sdk/client-s3: el sandbox donde se
// desarrolló esto no tiene salida a registry.npmjs.org, así que agregar una
// dependencia nueva sin poder regenerar package-lock.json hubiera roto
// `npm ci` en el build de Railway (ver railway.json). SigV4 es un algoritmo
// público y estable (no cambia con versiones de SDK) — usar solo el módulo
// `crypto` de Node evita ese riesgo por completo y no le pide nada nuevo a
// Ramon más allá de las 4 variables de entorno de R2.
import { createHash, createHmac } from "crypto";
import { config, isObjectStorageConfigured } from "../config";

export class ObjectStorageNotConfiguredError extends Error {
  constructor() {
    super(
      "El almacenamiento de medios (Cloudflare R2) todavía no está configurado en este servidor. " +
        "Faltan las variables R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y/o R2_BUCKET_NAME."
    );
    this.name = "ObjectStorageNotConfiguredError";
  }
}

const REGION = "auto";
const SERVICE = "s3";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function amzDateParts(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function encodeRfc3986(value: string): string {
  // encodeURIComponent no escapa algunos caracteres que SigV4 sí exige
  // (!, ', (, ), *) — sin esto, la firma no coincide con la que calcula R2.
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Genera una presigned URL (query-string SigV4) para un método HTTP dado
 * sobre un objeto del bucket configurado. `extraQuery` permite agregar
 * parámetros propios de la operación (ej. ninguno hoy, pero deja lugar a
 * futuro sin tener que tocar la firma).
 */
function presign(method: "PUT" | "GET" | "DELETE", storageKey: string, expiresInSeconds: number, extraHeaders: Record<string, string> = {}): string {
  if (!isObjectStorageConfigured()) throw new ObjectStorageNotConfiguredError();

  const host = `${config.r2AccountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(new Date());
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const credential = `${config.r2AccessKeyId}/${credentialScope}`;

  const signedHeaderNames = ["host", ...Object.keys(extraHeaders).map((h) => h.toLowerCase())].sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${h === "host" ? host : extraHeaders[Object.keys(extraHeaders).find((k) => k.toLowerCase() === h)!]}\n`).join("");

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaderNames.join(";"),
  };
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join("&");

  const canonicalUri = "/" + config.r2BucketName + "/" + storageKey.split("/").map(encodeRfc3986).join("/");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${config.r2SecretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Clave de objeto única y prolija dentro del bucket: organización/hip/kind/id
 * — así se puede navegar el bucket a mano si hace falta depurar algo, y no
 * hay colisión posible entre organizaciones ni entre Hips.
 */
export function buildStorageKey(params: { organizationId: string; hipId: string; kind: string; mediaAssetId: string; contentType?: string }): string {
  const ext = extensionFor(params.contentType);
  return `${params.organizationId}/${params.hipId}/${params.kind.toLowerCase()}/${params.mediaAssetId}${ext}`;
}

function extensionFor(contentType?: string): string {
  switch (contentType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/heic":
      return ".heic";
    case "video/quicktime":
      return ".mov";
    case "video/mp4":
      return ".mp4";
    default:
      return "";
  }
}

/** URL firmada de subida (PUT) — el dispositivo sube el archivo directo a esta URL. */
export function createUploadUrl(storageKey: string, expiresInSeconds = 900): string {
  return presign("PUT", storageKey, expiresInSeconds);
}

/**
 * URL de lectura: pública directa si R2_PUBLIC_BASE_URL está configurado
 * (más rápida, sin firmar nada); si no, una presigned URL de lectura.
 */
export function resolveReadUrl(storageKey: string, expiresInSeconds = 3600): string {
  if (config.r2PublicBaseUrl) {
    return `${config.r2PublicBaseUrl.replace(/\/$/, "")}/${storageKey}`;
  }
  return presign("GET", storageKey, expiresInSeconds);
}

/** URL firmada de borrado — usada al hacer tombstone de un MediaAsset, para no dejar el objeto huérfano en el bucket. */
export function createDeleteUrl(storageKey: string, expiresInSeconds = 60): string {
  return presign("DELETE", storageKey, expiresInSeconds);
}

/** Ejecuta el borrado firmado directamente desde el servidor (fetch nativo de Node 20). */
export async function deleteObject(storageKey: string): Promise<void> {
  const url = createDeleteUrl(storageKey);
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`No se pudo borrar el objeto ${storageKey} de R2: HTTP ${res.status}`);
  }
}
