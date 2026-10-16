import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotProcess } from '../server/snapshot-process.js';
import {
  processDestinationCatalogRequest,
  recoverDestinationCatalogHelper,
} from '../server/destination-catalog-helper.js';
import {
  decryptDatabase,
  readEnvelope,
  snapshotKey,
  writeEnvelope,
} from '../server/snapshot-files.js';
import {
  destinationCatalogMetadata,
  destinationCatalogPrefix,
  validDestinationRequest,
  validDestinationResult,
  type DestinationCatalogResult,
} from '../server/destination-catalog-files.js';

vi.mock('../server/snapshot-process.js', () => ({ snapshotProcess: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jellyport-destination-protocol-'));
  roots.push(root);
  const key = await snapshotKey(root, true),
    id = randomUUID(),
    prefix = destinationCatalogPrefix(id);
  const timestamp = new Date().toISOString();
  const request = {
    purpose: 'jellyfin_catalog' as const,
    id,
    requested_at: timestamp,
    binding: { url: 'http://jellyfin:8096/', server_id: 'a'.repeat(32), version: '12.2.0' },
  };
  await writeEnvelope(join(root, `${prefix}.request`), request, key);
  const worker = vi.mocked(snapshotProcess);
  worker.mockImplementation(async (value: unknown) => {
    const request = value as { output: string };
    await writeFile(request.output, 'synthetic-neutral-catalog');
    return {
      bytes: 25,
      items: 1,
      keys: 2,
      backup_created_at: timestamp,
      backup_fingerprint: 'b'.repeat(64),
      server_version: '12.2.0.0',
      backup_engine_version: '0.2.0',
    };
  });
  const process = () =>
    processDestinationCatalogRequest(
      `${prefix}.request`,
      root,
      root,
      '/synthetic-backups',
      key,
      new AbortController().signal,
    );
  const result = () => readEnvelope<DestinationCatalogResult>(join(root, `${prefix}.result`), key);
  return { root, key, id, prefix, request, worker, process, result };
}
it('publishes only encrypted neutral projection and authenticated original-age metadata', async () => {
  const f = await fixture();
  expect(await f.process()).toBe(true);
  const result = await f.result();
  expect(validDestinationResult(result)).toBe(true);
  expect(destinationCatalogMetadata(result)).toMatchObject({
    items: 1,
    backup_created_at: f.request.requested_at,
  });
  const bytes = await readFile(join(f.root, `${f.prefix}.db.enc`));
  expect(bytes.includes(Buffer.from('synthetic-neutral-catalog'))).toBe(false);
  const output = join(f.root, 'read.db');
  await decryptDatabase(join(f.root, `${f.prefix}.db.enc`), output, f.key, f.id);
  expect(await readFile(output, 'utf8')).toBe('synthetic-neutral-catalog');
  expect(
    (await readdir(f.root)).some(
      (name) =>
        name.startsWith('capture-') ||
        name.endsWith('.pending') ||
        name.endsWith('.working') ||
        name.endsWith('.request'),
    ),
  ).toBe(false);
});
it('contains worker errors without exposing source paths or replacing unrelated good generations', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'unrelated-good.db.enc'), 'good');
  f.worker.mockRejectedValue(new Error('/private/backup/user-history private credential'));
  await f.process();
  const result = await f.result();
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain('/private');
  expect(JSON.stringify(result)).not.toContain('credential');
  expect(await readFile(join(f.root, 'unrelated-good.db.enc'), 'utf8')).toBe('good');
  expect(await readdir(f.root)).not.toContain(`${f.prefix}.db.enc`);
});
it('rejects expired requests before reading the backup and leaves Emby requests untouched', async () => {
  const f = await fixture();
  await writeEnvelope(
    join(f.root, `${f.prefix}.request`),
    { ...f.request, requested_at: '2020-01-01T00:00:00Z' },
    f.key,
  );
  await f.process();
  expect(f.worker).not.toHaveBeenCalled();
  expect(
    await processDestinationCatalogRequest(
      `${f.id}.request`,
      f.root,
      f.root,
      '/synthetic',
      f.key,
      new AbortController().signal,
    ),
  ).toBe(false);
});
it('retains a completely committed generation during helper restart recovery', async () => {
  const f = await fixture();
  await f.process();
  await writeEnvelope(join(f.root, `${f.prefix}.working`), f.request, f.key);
  await recoverDestinationCatalogHelper(f.root, f.key);
  expect(validDestinationResult(await f.result())).toBe(true);
  expect(await readdir(f.root)).toContain(`${f.prefix}.db.enc`);
});
it('marks incomplete publication interrupted and never retries the source automatically', async () => {
  const f = await fixture();
  await rm(join(f.root, `${f.prefix}.request`));
  await writeEnvelope(join(f.root, `${f.prefix}.working`), f.request, f.key);
  await writeFile(join(f.root, `${f.prefix}.db.enc`), 'incomplete');
  await writeFile(join(f.root, `${f.prefix}.db.enc.pending`), 'pending');
  await recoverDestinationCatalogHelper(f.root, f.key);
  expect((await f.result()).ok).toBe(false);
  expect(f.worker).not.toHaveBeenCalled();
  expect(await readdir(f.root)).not.toContain(`${f.prefix}.db.enc`);
  expect(await readdir(f.root)).not.toContain(`${f.prefix}.db.enc.pending`);
});
it.each([
  'https://user:secret@jellyfin/',
  'http://',
  'file:///backup',
  'https://jellyfin/#private',
])('rejects invalid or credential-bearing binding %s', async (url) => {
  const f = await fixture();
  expect(validDestinationRequest({ ...f.request, binding: { ...f.request.binding, url } })).toBe(
    false,
  );
});
