import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { HttpError } from "./errors";

export function objectKey(prefix: string, folder: string, id: string, name: string) {
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 8);
  return `${clean}/${folder}/${id}${ext}`;
}

function s3Settings() {
  const bucket = process.env.S3_BUCKET?.trim() ?? "";
  const region = process.env.S3_REGION?.trim() ?? "";
  const accessKeyId = process.env.S3_ACCESS_KEY?.trim() ?? "";
  const secretAccessKey = process.env.S3_SECRET_KEY?.trim() ?? "";
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: (process.env.S3_PREFIX?.trim() || "workspace").replace(/^\/+|\/+$/g, ""),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  };
}

function clientFor() {
  const settings = s3Settings();
  if (!settings) return null;
  return {
    settings,
    client: new S3Client({
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    }),
  };
}

function localPath(uploadDir: string, ref: string) {
  const root = path.resolve(uploadDir);
  const full = path.resolve(root, path.basename(ref));
  if (full === root || !full.startsWith(`${root}${path.sep}`)) return null;
  return full;
}

export async function storeBytes(folder: string, name: string, buffer: Buffer, mime: string, uploadDir: string) {
  const remote = clientFor();
  if (remote) {
    const key = objectKey(remote.settings.prefix, folder, randomBytes(16).toString("hex"), name);
    try {
      await remote.client.send(new PutObjectCommand({
        Bucket: remote.settings.bucket,
        Key: key,
        Body: buffer,
        ContentType: mime,
      }));
    } catch {
      throw new HttpError(502, "Could not store that file.");
    }
    return `s3:${key}`;
  }
  const id = randomBytes(16).toString("hex");
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, id), buffer);
  return id;
}

export async function readStored(ref: string, uploadDir: string) {
  if (ref.startsWith("s3:")) {
    const remote = clientFor();
    if (!remote) throw new HttpError(503, "File storage is not configured.");
    try {
      const result = await remote.client.send(new GetObjectCommand({ Bucket: remote.settings.bucket, Key: ref.slice(3) }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw new HttpError(502, "Could not open that file.");
    }
  }
  const full = localPath(uploadDir, ref);
  if (!full || !fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

export async function deleteStored(ref: string, uploadDir: string) {
  if (ref.startsWith("s3:")) {
    const remote = clientFor();
    if (!remote) return;
    await remote.client.send(new DeleteObjectCommand({ Bucket: remote.settings.bucket, Key: ref.slice(3) })).catch(() => undefined);
    return;
  }
  const full = localPath(uploadDir, ref);
  if (full) fs.rmSync(full, { force: true });
}
