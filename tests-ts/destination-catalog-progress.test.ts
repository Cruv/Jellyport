import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { snapshotProcess } from '../server/snapshot-process.js';
import {
  destinationCatalogErrorCode,
  validDestinationDiagnostic,
  type DestinationCatalogDiagnostic,
} from '../server/destination-catalog-files.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));
let child: EventEmitter & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
const diagnostic: DestinationCatalogDiagnostic = {
  stage: 'reading_items',
  started_at: '2026-10-18T12:00:00.000Z',
  updated_at: '2026-10-18T12:00:01.000Z',
  source_rows: 100,
  provider_rows: 0,
  items: 80,
  keys: 0,
  bytes: 0,
};
const request = {
  operation: 'destination_capture',
  directory: '/synthetic/private',
  output: '/synthetic/output',
  version: '12.2.0',
};
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { kill: vi.fn(), send: vi.fn() });
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it.each([
  { ...diagnostic, stage: 'private-path' },
  { ...diagnostic, private: 'history' },
  { ...diagnostic, items: -1 },
  { ...diagnostic, items: 2_000_001 },
  { ...diagnostic, keys: Number.NaN },
  { ...diagnostic, bytes: Number.POSITIVE_INFINITY },
  { ...diagnostic, source_rows: 0.5 },
  { ...diagnostic, started_at: '2026-02-30T12:00:00.000Z' },
  { ...diagnostic, updated_at: '2026-10-18T11:00:00.000Z' },
])('rejects unbounded or private progress at the IPC boundary (%j)', async (value) => {
  expect(validDestinationDiagnostic(value)).toBe(false);
  const onProgress = vi.fn();
  const work = snapshotProcess(request, undefined, undefined, { onProgress });
  child.emit('message', { type: 'progress', value });
  child.emit('message', { ok: true, value: { items: 1 } });
  child.emit('close', 0);
  await expect(work).resolves.toEqual({ items: 1 });
  expect(onProgress).not.toHaveBeenCalled();
});

it('retains validated aggregate progress and safe failure codes while discarding raw worker errors', async () => {
  const onProgress = vi.fn();
  const work = snapshotProcess(request, undefined, undefined, { onProgress });
  child.emit('message', { type: 'progress', value: diagnostic });
  child.emit('message', {
    ok: false,
    error_code: 'backup_expired',
    error: '/private-user-history',
  });
  child.emit('close', 1);
  await expect(work).rejects.toMatchObject({ error_code: 'backup_expired', diagnostic });
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(diagnostic);
});

it('treats unknown worker causes and unexpected exits as worker_failed without exposing raw text', async () => {
  const work = snapshotProcess(request);
  child.emit('message', {
    ok: false,
    error_code: '/private-user-history',
    error: '/private-user-history',
  });
  child.emit('close', 1);
  await expect(work).rejects.toMatchObject({ error_code: 'worker_failed' });
  await expect(work).rejects.not.toThrow('/private-user-history');
  const stopped = snapshotProcess(request);
  child.emit('close', null);
  await expect(stopped).rejects.toMatchObject({ error_code: 'worker_failed' });
});

it('contains observer exceptions and preserves the existing terminal success contract', async () => {
  const work = snapshotProcess(request, undefined, undefined, {
    onProgress: () => {
      throw new Error('observer');
    },
  });
  child.emit('message', { type: 'progress', value: diagnostic });
  child.emit('message', { ok: true, value: { items: 80 } });
  child.emit('close', 0);
  await expect(work).resolves.toEqual({ items: 80 });
});

it('kills and reaps timed-out or canceled imports with their last safe diagnostic', async () => {
  vi.useFakeTimers();
  const timed = snapshotProcess(request, undefined, 5);
  child.emit('message', { type: 'progress', value: diagnostic });
  await vi.advanceTimersByTimeAsync(5);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  // A queued worker reply cannot replace a deadline that already ended the work.
  child.emit('message', { ok: false, error_code: 'backup_invalid' });
  child.emit('close', null);
  await expect(timed).rejects.toMatchObject({ error_code: 'timeout', diagnostic });
  const controller = new AbortController();
  const canceled = snapshotProcess(request, controller.signal);
  controller.abort();
  child.emit('close', null);
  await expect(canceled).rejects.toMatchObject({ error_code: 'canceled' });
});

it('classifies storage failures without copying operating-system or SQLite error text', () => {
  expect(
    destinationCatalogErrorCode(Object.assign(new Error('/private'), { code: 'ENOSPC' })),
  ).toBe('storage_error');
  expect(
    destinationCatalogErrorCode({ code: 'ERR_SQLITE_ERROR', errcode: 13, message: '/private' }),
  ).toBe('storage_error');
  expect(destinationCatalogErrorCode(new Error('/private'))).toBe('backup_invalid');
});
