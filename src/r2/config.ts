/**
 * Cloudflare R2 (S3 API). Không đặt credential trong repo — chỉ .env local / secret manager.
 */

export type R2Settings = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  signedUrlTtlSeconds: number;
};

function trimEnv(v: string | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Trả null nếu thiếu biến bắt buộc — API sẽ giữ screenshot dạng base64 trong DB (hành vi cũ).
 * Hỗ trợ thêm alias: R2_S3_ENDPOINT, biến `s3=` (endpoint), cloudflare_* (key/secret).
 */
export function resolveR2Settings(): R2Settings | null {
  const endpoint = trimEnv(
    process.env.R2_ENDPOINT ??
      process.env.R2_S3_ENDPOINT ??
      process.env.S3_ENDPOINT ??
      process.env["s3"],
  );
  const bucket = trimEnv(process.env.R2_BUCKET);
  const accessKeyId = trimEnv(process.env.R2_ACCESS_KEY_ID ?? process.env.cloudflare_access_key_id);
  const secretAccessKey = trimEnv(
    process.env.R2_SECRET_ACCESS_KEY ?? process.env.cloudflare_secret_access_key,
  );

  const region = trimEnv(process.env.R2_REGION) || "auto";
  const ttlRaw = Number(process.env.R2_SIGNED_URL_TTL_SECONDS ?? process.env.R2_PRESIGN_TTL_SECONDS);
  const signedUrlTtlSeconds =
    Number.isFinite(ttlRaw) && ttlRaw > 60 ? Math.min(Math.floor(ttlRaw), 604800) : 3600;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    signedUrlTtlSeconds,
  };
}
