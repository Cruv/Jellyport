import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import { Service } from '../server/service.js';
import { IdentityRoleSync } from '../server/identity-role-sync.js';
import type { UserOrganization } from '../server/user-organization.js';

const owner = '234567890123456789';
const owner2 = '345678901234567890';
const secret = 'synthetic-role-outbox-key';
const resources: Array<{
  directory: string;
  store: Store;
  service: Service;
  workers: IdentityRoleSync[];
}> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function fixture(
  syncOwners: UserOrganization['syncOwners'] = async () => ({ updated: 1, failed: 0 }),
) {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-identity-role-sync-'));
  const store = new Store(directory);
  store.saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    emby_url: 'http://emby.example.test',
    emby_api_key: secret,
    jellyfin_url: 'http://jellyfin.example.test',
    jellyfin_api_key: secret,
    discord_guild_id: '123456789012345678',
    discord_emby_role_id: '900001',
    discord_jellyfin_role_id: '900002',
    discord_emby_only_role: false,
  });
  const service = new Service(store);
  const callback = vi.fn(syncOwners);
  const organization = { syncOwners: callback } as unknown as UserOrganization;
  const worker = new IdentityRoleSync(service, organization);
  const resource = { directory, store, service, workers: [worker] };
  resources.push(resource);
  return { ...resource, worker, callback, organization };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const { directory, store, service, workers } of resources.splice(0)) {
    for (const worker of workers) await worker.close();
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable bounded identity organization-role outbox', () => {
  it('returns queued status after four seconds without waiting for a slow Discord write', async () => {
    vi.useFakeTimers();
    const finish = deferred<void>();
    const { worker, callback } = fixture(async (_owners, guard) => {
      await finish.promise;
      guard?.();
      return { updated: 1, failed: 0 };
    });
    const id = worker.enqueue([owner]);
    let returned = false;
    const result = worker.withinBudget(id).then((value) => {
      returned = true;
      return value;
    });
    try {
      await vi.advanceTimersByTimeAsync(3999);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(returned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ status: 'queued', task_id: id, updated: 0, failed: 0 });
      expect(returned).toBe(true);
    } finally {
      finish.resolve();
    }
    await worker.start();
    expect(worker.status(id)).toMatchObject({ status: 'updated', updated: 1, failed: 0 });
  });

  it('deduplicates owners, preserves stopped work, and safely resumes partial role delivery after restart', async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const applied = new Set<string>();
    const writes: string[] = [];
    let first = true;
    const f = fixture(async (owners, guard) => {
      let updated = 0;
      for (const id of owners) {
        guard?.();
        if (!applied.has(id)) {
          applied.add(id);
          writes.push(id);
          updated++;
        }
        if (first) {
          first = false;
          entered.resolve();
          await finish.promise;
          guard?.();
        }
      }
      return { updated, failed: 0 };
    });
    const id = f.worker.enqueue([owner, owner, owner2]);
    const running = f.worker.start();
    await entered.promise;
    const closing = f.worker.close();
    finish.resolve();
    await Promise.all([running, closing]);
    expect(f.worker.status(id)).toMatchObject({ status: 'queued' });
    expect(writes).toEqual([owner]);
    const restarted = new IdentityRoleSync(f.service, f.organization);
    f.workers.push(restarted);
    await Promise.all([restarted.start(), restarted.start()]);
    expect(restarted.status(id)).toMatchObject({
      status: 'updated',
      task_id: id,
      updated: 1,
      failed: 0,
    });
    expect(writes).toEqual([owner, owner2]);
    expect(f.callback.mock.calls[0]![0]).toEqual([owner, owner2]);
    await restarted.start();
    expect(writes).toEqual([owner, owner2]);
  });

  it('rejects changed role configuration before executing any queued task', async () => {
    const { worker, store, callback } = fixture();
    const id = worker.enqueue([owner]);
    store.saveSettings({ ...store.settings(), discord_emby_role_id: '900003' });
    await worker.start();
    expect(callback).not.toHaveBeenCalled();
    expect(worker.status(id)).toMatchObject({ status: 'failed', updated: 0, failed: 0 });
    expect(worker.status(id).message).not.toContain(secret);
  });

  it('checks context again before a write resumed after an asynchronous wait', async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const writes: string[] = [];
    const { worker, store } = fixture(async (owners, guard) => {
      entered.resolve();
      await finish.promise;
      guard?.();
      writes.push(...owners);
      return { updated: owners.length, failed: 0 };
    });
    const id = worker.enqueue([owner]);
    const running = worker.start();
    await entered.promise;
    store.saveSettings({ ...store.settings(), discord_emby_only_role: true });
    finish.resolve();
    await running;
    expect(writes).toEqual([]);
    expect(worker.status(id).status).toBe('failed');
  });

  it('retains failed delivery for review and retries idempotently through a new approved task', async () => {
    let fail = true;
    const applied = new Set<string>();
    const writes: string[] = [];
    const { worker } = fixture(async (owners, guard) => {
      guard?.();
      if (fail) throw new Error(`Synthetic private upstream error ${secret} ${owner}`);
      let updated = 0;
      for (const id of owners)
        if (!applied.has(id)) {
          applied.add(id);
          writes.push(id);
          updated++;
        }
      return { updated, failed: 0 };
    });
    const first = worker.enqueue([owner]);
    await worker.start();
    expect(worker.status(first).status).toBe('failed');
    expect(JSON.stringify(worker.recent())).not.toContain(secret);
    fail = false;
    const retry = worker.enqueue([owner]);
    await worker.start();
    expect(worker.status(retry)).toMatchObject({ status: 'updated', updated: 1 });
    const repeated = worker.enqueue([owner]);
    await worker.start();
    expect(worker.status(repeated)).toMatchObject({ status: 'updated', updated: 0 });
    expect(writes).toEqual([owner]);
  });

  it('exposes only the latest twenty scoped aggregate outcomes without owner identities or secrets', async () => {
    const { worker, store } = fixture();
    for (let index = 0; index < 25; index++) {
      worker.enqueue([owner]);
      await worker.start();
    }
    const recent = worker.recent();
    expect(recent.tasks).toHaveLength(20);
    for (const task of recent.tasks)
      expect(Object.keys(task).sort()).toEqual([
        'created_at',
        'failed',
        'status',
        'task_id',
        'updated',
      ]);
    expect(JSON.stringify(recent)).not.toContain(owner);
    expect(JSON.stringify(recent)).not.toContain(secret);
    store.saveSettings({ ...store.settings(), discord_guild_id: '987654321012345678' });
    expect(worker.recent()).toEqual({ tasks: [] });
    expect(() => worker.status(recent.tasks[0]!.task_id)).toThrow(/current server/i);
  });

  it('bounds queued work and retains a bounded history of completed tasks', async () => {
    const queued = fixture();
    for (let index = 0; index < 100; index++) queued.worker.enqueue([owner]);
    expect(() => queued.worker.enqueue([owner])).toThrow(/pending Discord role updates/i);
    await queued.worker.start();
    for (let index = 0; index < 25; index++) {
      queued.worker.enqueue([owner]);
      await queued.worker.start();
    }
    expect(
      queued.store.db.prepare('SELECT COUNT(*) AS count FROM identity_role_sync_tasks').get()
        ?.count,
    ).toBeLessThanOrEqual(101);
  });
});
