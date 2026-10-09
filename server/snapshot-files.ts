import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

export const snapshotId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SNAPSHOT_VERSION = '4.10.1.0';
export const MAX_SNAPSHOT_BYTES = 8 * 1024 ** 3;
export const CAPTURE_DEADLINE = 5 * 60_000;
const aad = Buffer.from('Jellyport SQLite snapshot v1');

export async function regular(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular snapshot file.');
}
export async function snapshotKey(directory: string, create = false): Promise<Buffer> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'snapshot.key');
  if (create) {
    try {
      await writeFile(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  await regular(path);
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('Invalid snapshot encryption key.');
  return key;
}
export function seal(value: unknown, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}
export function unseal<T>(value: Buffer, key: Buffer): T {
  if (value.length < 28) throw new Error('Invalid snapshot envelope.');
  const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  cipher.setAAD(aad);
  cipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(),
  ) as T;
}
export async function readEnvelope<T>(path: string, key: Buffer): Promise<T> {
  await regular(path);
  const info = await lstat(path);
  if (info.size > 1024 * 1024) throw new Error('Snapshot metadata exceeds its limit.');
  return unseal<T>(await readFile(path), key);
}
export async function writeEnvelope(path: string, value: unknown, key: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, seal(value, key), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
export async function encryptDatabase(
  source: string,
  target: string,
  key: Buffer,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([aad, Buffer.from(id)]));
  await writeFile(target, nonce, { mode: 0o600, flag: 'wx' });
  await pipeline(
    createReadStream(source),
    cipher,
    createWriteStream(target, { flags: 'a', mode: 0o600 }),
    { signal },
  );
  await writeFile(target, cipher.getAuthTag(), { flag: 'a' });
}
export async function decryptDatabase(
  source: string,
  target: string,
  key: Buffer,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await regular(source);
  const { size } = await lstat(source);
  if (size < 28 || size > MAX_SNAPSHOT_BYTES + 28) throw new Error('Invalid snapshot size.');
  const { open } = await import('node:fs/promises');
  const file = await open(source, 'r');
  const nonce = Buffer.alloc(12),
    tag = Buffer.alloc(16);
  try {
    await file.read(nonce, 0, 12, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally {
    await file.close();
  }
  const cipher = createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([aad, Buffer.from(id)]));
  cipher.setAuthTag(tag);
  // Create exclusively before streaming so failure cleanup cannot unlink somebody else's file.
  await writeFile(target, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  try {
    await pipeline(
      createReadStream(source, { start: 12, end: size - 17 }),
      cipher,
      createWriteStream(target, { flags: 'a', mode: 0o600 }),
      { signal },
    );
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

export interface SnapshotBinding {
  url: string;
  server_id: string;
  version: string;
}
export interface CaptureRequest {
  id: string;
  requested_at: string;
  binding: SnapshotBinding;
  user_ids?: string[];
}
export interface CaptureResult extends CaptureRequest {
  ok: boolean;
  started_at: string;
  finished_at: string;
  bytes?: number;
  item_count?: number;
  schema?: string;
  identities?: Record<string, number>;
  error?: string;
}
