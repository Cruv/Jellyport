import { mkdir, mkdtemp, readdir, rename, rm, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotProcess } from './snapshot-process.js';
import { processJellyfinBackupCleanupRequest } from './jellyfin-backup-retention.js';
import {
  processDestinationCatalogRequest,
  recoverDestinationCatalogHelper,
} from './destination-catalog-helper.js';
import {
  CAPTURE_DEADLINE,
  SNAPSHOT_PROJECTION_SCHEMA,
  encryptDatabase,
  readEnvelope,
  recoverSnapshotHelper,
  regular,
  snapshotId,
  snapshotKey,
  snapshotCaptureMethod,
  snapshotIdentitiesMatch,
  snapshotOrphanIdentityVersion,
  validatedSnapshotRequest,
  writeEnvelope,
  type CaptureRequest,
  type CaptureResult,
} from './snapshot-files.js';
import type { PluginBackupCaptureResult } from './plugin-backup.js';

const directory = process.env.JELLYPORT_SNAPSHOT_DIR;
const workDirectory = process.env.JELLYPORT_SNAPSHOT_WORK_DIR;
const jellyfinBackups = process.env.JELLYPORT_JELLYFIN_BACKUP_DIR;
const jellyfinBackupCleanup = process.env.JELLYPORT_JELLYFIN_BACKUP_CLEANUP === 'true';
const captureMethod = snapshotCaptureMethod(process.env.JELLYPORT_SNAPSHOT_METHOD);
const source =
  captureMethod === 'plugin_backup'
    ? process.env.JELLYPORT_EMBY_BACKUP_DIR
    : process.env.JELLYPORT_EMBY_DATA_DIR;
if (!directory || !source || !workDirectory)
  throw new Error(
    'Configure the snapshot exchange, private work directory and selected Emby source mount.',
  );
const embyCaptureCapability = {
  capture_method: captureMethod,
  ...(captureMethod === 'plugin_backup'
    ? { plugin_backup_schema: SNAPSHOT_PROJECTION_SCHEMA }
    : {}),
};
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(workDirectory, { recursive: true, mode: 0o700 });
process.env.SQLITE_TMPDIR = workDirectory;
if (directory === workDirectory)
  throw new Error('The helper work directory must be separate from the snapshot exchange.');
async function sourceIdentity(serverId: string): Promise<void> {
  const path = join(source!, 'device.txt');
  await regular(path);
  if (
    (await lstat(path)).size > 128 ||
    (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim() !== serverId
  )
    throw new Error('The mounted Emby server identity does not match.');
}
const heartbeat = setInterval(() => {
  void snapshotKey(directory)
    .then((key) =>
      writeEnvelope(
        join(directory, 'helper.status'),
        {
          version: 1,
          ...embyCaptureCapability,
          jellyfin_catalog_enabled: !!jellyfinBackups,
          jellyfin_backup_selection_enabled: !!jellyfinBackups,
          jellyfin_backup_cleanup_enabled: !!jellyfinBackups && jellyfinBackupCleanup,
          updated_at: new Date().toISOString(),
        },
        key,
      ),
    )
    .catch(() => {});
}, 2000);
heartbeat.unref();
let stopping = false;
let recovered = false;
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopping = true;
    controller.abort();
  });
// Only this helper's known temporary artifacts are removed after an interrupted capture.
for (const name of await readdir(workDirectory))
  if (/^capture-[a-f0-9-]{36}-[A-Za-z0-9]+$/.test(name))
    await rm(join(workDirectory, name), { recursive: true, force: true });
while (!stopping) {
  try {
    const key = await snapshotKey(directory);
    if (!recovered) {
      await recoverSnapshotHelper(directory, key);
      await recoverDestinationCatalogHelper(directory, key);
      recovered = true;
    }
    await writeEnvelope(
      join(directory, 'helper.status'),
      {
        version: 1,
        ...embyCaptureCapability,
        jellyfin_catalog_enabled: !!jellyfinBackups,
        jellyfin_backup_selection_enabled: !!jellyfinBackups,
        jellyfin_backup_cleanup_enabled: !!jellyfinBackups && jellyfinBackupCleanup,
        updated_at: new Date().toISOString(),
      },
      key,
    );
    for (const name of await readdir(directory)) {
      if (stopping) break;
      if (
        await processJellyfinBackupCleanupRequest(
          name,
          directory,
          jellyfinBackups,
          jellyfinBackupCleanup,
          key,
          controller.signal,
        )
      )
        continue;
      if (
        await processDestinationCatalogRequest(
          name,
          directory,
          workDirectory,
          jellyfinBackups,
          key,
          controller.signal,
        )
      )
        continue;
      if (!name.endsWith('.request') || !snapshotId.test(name.slice(0, -8))) continue;
      const id = name.slice(0, -8),
        path = join(directory, name);
      let request: CaptureRequest;
      try {
        request = validatedSnapshotRequest(await readEnvelope<CaptureRequest>(path, key), id);
        if (Math.abs(Date.now() - Date.parse(request.requested_at)) > CAPTURE_DEADLINE)
          throw new Error('Invalid capture request.');
        await rename(path, join(directory, `${id}.working`));
      } catch {
        await rm(path, { force: true });
        continue;
      }
      const started_at = new Date().toISOString();
      let temporary: string | undefined;
      let result: CaptureResult;
      try {
        if (snapshotCaptureMethod(request.capture_method) !== captureMethod)
          throw new Error('The helper capture method changed. Request a new capture.');
        if (captureMethod !== 'plugin_backup') await sourceIdentity(request.binding.server_id);
        temporary = await mkdtemp(join(workDirectory, `capture-${id}-`));
        const output = join(temporary, 'library.db');
        const value = await snapshotProcess<
          Partial<PluginBackupCaptureResult> & {
            identities: Record<string, number>;
            schema: string;
            bytes: number;
          }
        >(
          {
            operation: 'capture',
            directory: source,
            output,
            capture_method: captureMethod,
            server_id: request.binding.server_id,
          },
          controller.signal,
        );
        snapshotOrphanIdentityVersion(value.orphan_identity_version);
        if (!snapshotIdentitiesMatch(value.identities, request.user_ids, captureMethod))
          throw new Error('The mounted database does not contain the requested users.');
        if (captureMethod !== 'plugin_backup') await sourceIdentity(request.binding.server_id);
        await encryptDatabase(
          output,
          join(directory, `${id}.db.enc.pending`),
          key,
          id,
          controller.signal,
        );
        await rename(join(directory, `${id}.db.enc.pending`), join(directory, `${id}.db.enc`));
        result = {
          ...request,
          capture_method: captureMethod,
          ok: true,
          started_at,
          finished_at: new Date().toISOString(),
          ...value,
        };
      } catch {
        result = {
          ...request,
          ok: false,
          started_at,
          finished_at: new Date().toISOString(),
          error:
            captureMethod === 'plugin_backup'
              ? 'Emby backup import failed. Check that the full backup is complete, mounted read-only, and uses a supported layout. Any previously saved capture is preserved.'
              : 'Database capture failed. Check the Emby server identity, helper mount, database layout, permissions and WAL files. Any previously saved capture is preserved.',
        };
        await rm(join(directory, `${id}.db.enc`), { force: true });
      } finally {
        await rm(join(directory, `${id}.db.enc.pending`), { force: true });
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
      await writeEnvelope(join(directory, `${id}.result`), result, key);
      await rm(join(directory, `${id}.working`), { force: true });
    }
  } catch {
    /* No secrets or filesystem paths in container logs. Wait for a valid shared key/mount. */
  }
  if (!stopping) await delay(2000, undefined, { signal: controller.signal }).catch(() => {});
}
clearInterval(heartbeat);
