import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotProcess } from '../server/snapshot-process.js';
import * as snapshotFiles from '../server/snapshot-files.js';
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
  validDestinationProgress,
  validDestinationDiagnostic,
  DestinationCatalogError,
  type DestinationCatalogDiagnostic,
  type DestinationCatalogResult,
} from '../server/destination-catalog-files.js';

vi.mock('../server/snapshot-process.js', () => ({ snapshotProcess: vi.fn() }));
const roots: string[] = [];
const diagnostic = (
  stage: DestinationCatalogDiagnostic['stage'] = 'reading_items',
): DestinationCatalogDiagnostic => {
  const timestamp = new Date().toISOString();
  return {
    stage,
    started_at: timestamp,
    updated_at: timestamp,
    source_rows: 5,
    provider_rows: 0,
    items: 2,
    keys: 0,
    bytes: 0,
  };
};
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.restoreAllMocks();
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
  const process = (signal = new AbortController().signal) =>
    processDestinationCatalogRequest(
      `${prefix}.request`,
      root,
      root,
      '/synthetic-backups',
      key,
      signal,
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
  expect(result.error_code).toBe('worker_failed');
  expect(JSON.stringify(result)).not.toContain('/private');
  expect(JSON.stringify(result)).not.toContain('credential');
  expect(await readFile(join(f.root, 'unrelated-good.db.enc'), 'utf8')).toBe('good');
  expect(await readdir(f.root)).not.toContain(`${f.prefix}.db.enc`);
});
it('publishes authenticated aggregate progress and retains a specific safe early failure without a completed catalog', async () => {
  const f = await fixture();
  f.worker.mockImplementation(async (_request, _signal, _timeout, options) => {
    options?.onProgress?.(diagnostic());
    throw new DestinationCatalogError('backup_expired', diagnostic());
  });
  await f.process();
  const progress = await readEnvelope<unknown>(join(f.root, `${f.prefix}.progress`), f.key);
  expect(validDestinationProgress(progress)).toBe(true);
  expect(progress).toMatchObject({ ...f.request, diagnostic: { source_rows: 5, items: 2 } });
  const result = await f.result();
  expect(result).toMatchObject({
    ok: false,
    error_code: 'backup_expired',
    diagnostic: { source_rows: 5, items: 2 },
  });
  expect(result.error).toContain('older than 48 hours');
  expect((await readdir(f.root)).filter((name) => name.endsWith('.db.enc'))).toEqual([]);
  expect(
    (await readFile(join(f.root, `${f.prefix}.progress`))).includes(Buffer.from('reading_items')),
  ).toBe(false);
});
it('flushes coalesced progress before publishing a terminal result so cleanup cannot race a late write', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = snapshotFiles.writeEnvelope;
  let first = true;
  vi.spyOn(snapshotFiles, 'writeEnvelope').mockImplementation(async (path, value, key, signal) => {
    if (path.endsWith('.progress') && first) {
      first = false;
      entered();
      await gate;
    }
    return original(path, value, key, signal);
  });
  const work = f.process();
  await blocked;
  await new Promise((resolve) => setImmediate(resolve));
  await expect(readFile(join(f.root, `${f.prefix}.result`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  release();
  await work;
  expect(await f.result()).toMatchObject({
    ok: true,
    diagnostic: { stage: 'validating_catalog', items: 1, keys: 2, bytes: 25 },
  });
  const path = join(f.root, `${f.prefix}.progress`);
  await rm(path);
  await new Promise((resolve) => setImmediate(resolve));
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['success', 'failure', 'canceled'] as const)(
  'bounds a hung optional progress flush and prevents late publication after terminal %s',
  async (outcome) => {
    const f = await fixture();
    const controller = new AbortController();
    const originalWorker = f.worker.getMockImplementation()!;
    f.worker.mockImplementation(async (...args) => {
      args[3]?.onProgress?.(diagnostic('indexing'));
      if (outcome === 'canceled') controller.abort();
      if (outcome !== 'success') throw new DestinationCatalogError('backup_expired');
      return originalWorker(...args);
    });
    let release!: () => void;
    let entered!: () => void;
    let finished!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const observerFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const original = snapshotFiles.writeEnvelope;
    let observerSignal: AbortSignal | undefined;
    let first = true;
    vi.spyOn(snapshotFiles, 'writeEnvelope').mockImplementation(async (...args) => {
      if (args[0].endsWith('.progress') && first) {
        first = false;
        observerSignal = args[3];
        entered();
        await gate;
        try {
          return await original(...args);
        } finally {
          finished();
        }
      }
      return original(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const work = f.process(controller.signal);
    try {
      await blocked;
      const waitUntil = performance.now() + 2000;
      while (!timers.mock.calls.some(([, delay]) => delay === 1000)) {
        if (performance.now() > waitUntil)
          throw new Error('No bounded progress flush was started.');
        await new Promise((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(999);
      await expect(readFile(join(f.root, `${f.prefix}.result`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await vi.advanceTimersByTimeAsync(1);
      await work;
      const result = await f.result();
      expect(result).toMatchObject({
        ok: outcome === 'success',
        diagnostic:
          outcome === 'success'
            ? { stage: 'validating_catalog', items: 1, keys: 2, bytes: 25 }
            : { stage: 'indexing', source_rows: 5, items: 2 },
        ...(outcome === 'success'
          ? {}
          : { error_code: outcome === 'canceled' ? 'canceled' : 'backup_expired' }),
      });
      expect(validDestinationResult(result)).toBe(outcome === 'success');
      expect(validDestinationDiagnostic(result.diagnostic)).toBe(true);
      expect(observerSignal?.aborted).toBe(true);
      const progressPath = join(f.root, `${f.prefix}.progress`);
      await rm(progressPath, { force: true });
      release();
      await observerFinished;
      await new Promise((resolve) => setImmediate(resolve));
      await expect(readFile(progressPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(f.root)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      release();
      vi.useRealTimers();
      await work;
    }
  },
);
it('ignores invalid progress fields and never exposes private worker diagnostics', async () => {
  const f = await fixture();
  f.worker.mockImplementation(async (_request, _signal, _timeout, options) => {
    options?.onProgress?.({ ...diagnostic(), path: '/synthetic-private-history' });
    throw new Error('/synthetic-private-history');
  });
  await f.process();
  const result = await f.result();
  expect(result).toMatchObject({
    error_code: 'worker_failed',
    diagnostic: { stage: 'validating_backup', source_rows: 0 },
  });
  expect(JSON.stringify(result)).not.toContain('synthetic-private-history');
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
  await writeEnvelope(
    join(f.root, `${f.prefix}.progress`),
    { ...f.request, diagnostic: diagnostic('indexing') },
    f.key,
  );
  await recoverDestinationCatalogHelper(f.root, f.key);
  expect(await f.result()).toMatchObject({
    ok: false,
    error_code: 'interrupted',
    diagnostic: { stage: 'indexing', source_rows: 5 },
  });
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
