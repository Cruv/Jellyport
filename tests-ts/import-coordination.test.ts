import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Service } from '../server/service.js';
import { Store, DEFAULT_SETTINGS } from '../server/store.js';
import type { MediaAPI } from '../server/media.js';
import {
  snapshotKey,
  readEnvelope,
  writeEnvelope,
  SNAPSHOT_VERSION,
  type CaptureRequest,
} from '../server/snapshot-files.js';
import {
  destinationCatalogPrefix,
  type DestinationCatalogRequest,
} from '../server/destination-catalog-files.js';

const resources: Array<{ service: Service; store: Store; directory: string }> = [];
afterEach(async () => {
  for (const { service, store, directory } of resources.splice(0)) {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(restored = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jellyport-synthetic-import-coordination-'));
  const shared = join(directory, 'shared');
  vi.stubEnv('JELLYPORT_SNAPSHOT_DIR', shared);
  vi.stubEnv('JELLYPORT_JELLYFIN_CATALOG_MODE', 'backup');
  vi.stubEnv('TZ', 'Etc/UTC');
  const store = new Store(join(directory, 'state'));
  store.saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    emby_url: 'http://emby:8096',
    emby_api_key: 'synthetic-source-key',
    jellyfin_url: 'http://jellyfin:8096',
    jellyfin_api_key: 'synthetic-destination-key',
  });
  const key = await snapshotKey(shared, true);
  const now = new Date().toISOString();
  const source: CaptureRequest = {
    id: randomUUID(),
    requested_at: now,
    binding: {
      url: 'http://emby:8096',
      server_id: 'synthetic-emby-server',
      version: SNAPSHOT_VERSION,
    },
    user_ids: ['a'.repeat(32)],
    capture_method: 'plugin_backup',
  };
  const destination: DestinationCatalogRequest = {
    purpose: 'jellyfin_catalog',
    id: randomUUID(),
    requested_at: now,
    binding: { url: 'http://jellyfin:8096/', server_id: 'b'.repeat(32), version: '12.2.0' },
  };
  async function fail(request: CaptureRequest | DestinationCatalogRequest) {
    const prefix = 'purpose' in request ? destinationCatalogPrefix(request.id) : request.id;
    await writeEnvelope(
      join(shared, `${prefix}.result`),
      {
        ...request,
        ok: false,
        started_at: now,
        finished_at: now,
        error: 'Backup import was interrupted.',
      },
      key,
    );
    await rm(join(shared, `${prefix}.request`), { force: true });
  }
  if (restored) {
    store.db.prepare('INSERT INTO source_snapshot_state VALUES(1,?)').run(
      store.encrypt({
        config: {
          enabled: false,
          hour: 3,
          minute: 0,
          time_zone: 'Etc/UTC',
          scope: 'complete',
          revision: randomUUID(),
        },
        active: source,
        generations: [],
        last_attempt_at: now,
        last_finished_at: null,
        last_error: null,
      }),
    );
    store.db.prepare('INSERT INTO destination_catalog_state VALUES(1,?)').run(
      store.encrypt({
        configured: true,
        active: destination,
        generations: [],
        last_attempt_at: now,
        last_error: null,
      }),
    );
    await fail(source);
    await fail(destination);
  }
  await writeEnvelope(
    join(shared, 'helper.status'),
    {
      version: 1,
      emby_version: SNAPSHOT_VERSION,
      capture_method: 'plugin_backup',
      jellyfin_catalog_enabled: true,
      updated_at: now,
    },
    key,
  );
  const sourceInfo = vi.fn(async () => ({
    Id: 'synthetic-emby-server',
    Version: SNAPSHOT_VERSION,
  }));
  const destinationInfo = vi.fn(async () => ({ Id: 'b'.repeat(32), Version: '12.2.0' }));
  const service = new Service(store, {
    clientFactory: (_url, _key, kind) =>
      ({
        systemInfo: kind === 'emby' ? sourceInfo : destinationInfo,
        users: async () => [{ Id: 'a'.repeat(32), Name: 'synthetic-member' }],
        close: async () => {},
      }) as unknown as MediaAPI,
  });
  resources.push({ service, store, directory });
  async function start(kind: 'sourceSnapshots' | 'destinationSnapshots') {
    const manager = service[kind];
    await manager.start();
    clearInterval((manager as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  }
  return { service, start, shared, key, fail, sourceInfo, destinationInfo };
}

it('shares helper ownership between real Service managers throughout binding lookup and accepted import', async () => {
  const f = await fixture();
  await f.start('sourceSnapshots');
  await f.start('destinationSnapshots');
  let release!: (value: { Id: string; Version: string }) => void;
  let entered!: () => void;
  const enteredLookup = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.sourceInfo.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.service.sourceSnapshots.refresh();
  await enteredLookup;
  await expect(f.service.destinationSnapshots.refresh()).rejects.toThrow('already running');
  expect(f.destinationInfo).not.toHaveBeenCalled();
  release({ Id: 'synthetic-emby-server', Version: SNAPSHOT_VERSION });
  await pending;
  await expect(f.service.destinationSnapshots.refresh()).rejects.toThrow('already running');
  const name = (await readdir(f.shared)).find((name) => name.endsWith('.request'))!;
  await f.fail(await readEnvelope<CaptureRequest>(join(f.shared, name), f.key));
  await (f.service.sourceSnapshots as unknown as { tick(): Promise<void> }).tick();
  await f.service.destinationSnapshots.refresh();
  expect(f.destinationInfo).toHaveBeenCalledOnce();
});

it('restores both legacy active owners before either manager starts polling', async () => {
  const f = await fixture(true);
  await expect(f.service.sourceSnapshots.refresh()).rejects.toThrow('already running');
  await f.start('sourceSnapshots');
  expect((await f.service.sourceSnapshots.status()).last_outcome).toBe('interrupted');
  await expect(f.service.sourceSnapshots.refresh()).rejects.toThrow('already running');
  await f.start('destinationSnapshots');
  expect((await f.service.destinationSnapshots.status()).last_outcome).toBe('interrupted');
  await f.service.sourceSnapshots.refresh();
  expect(f.sourceInfo).toHaveBeenCalledOnce();
});
