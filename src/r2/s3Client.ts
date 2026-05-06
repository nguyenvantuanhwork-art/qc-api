import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { R2Settings } from "./config";
import { resolveR2Settings } from "./config";

let cachedKey: string | null = null;
let client: S3Client | null = null;

function clientFor(settings: R2Settings): S3Client {
  const key = `${settings.endpoint}|${settings.region}|${settings.accessKeyId}`;
  if (!client || cachedKey !== key) {
    client = new S3Client({
      region: settings.region,
      endpoint: settings.endpoint,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      forcePathStyle: true,
    });
    cachedKey = key;
  }
  return client;
}

export function getR2Context(): { settings: R2Settings; client: S3Client } | null {
  const settings = resolveR2Settings();
  if (!settings) return null;
  return { settings, client: clientFor(settings) };
}

export async function putScreenshotPng(objectKey: string, body: Buffer): Promise<void> {
  const ctx = getR2Context();
  if (!ctx) throw new Error("R2 chưa cấu hình");
  const { settings, client: s3 } = ctx;
  await s3.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: objectKey,
      Body: body,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

export async function presignGetScreenshot(objectKey: string): Promise<string | null> {
  const ctx = getR2Context();
  if (!ctx) return null;
  const { settings, client: s3 } = ctx;
  const cmd = new GetObjectCommand({ Bucket: settings.bucket, Key: objectKey });
  return getSignedUrl(s3, cmd, { expiresIn: settings.signedUrlTtlSeconds });
}
