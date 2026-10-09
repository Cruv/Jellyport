import { mkdir, mkdtemp, readdir, rename, rm, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotProcess } from './snapshot-process.js';
import {
  CAPTURE_DEADLINE,
  SNAPSHOT_VERSION,
  encryptDatabase,
  readEnvelope,
  recoverSnapshotHelper,
  regular,
  snapshotId,
  snapshotKey,
  writeEnvelope,
  type CaptureRequest,
  type CaptureResult,
} from './snapshot-files.js';

const directory = process.env.JELLYPORT_SNAPSHOT_DIR;
const source = process.env.JELLYPORT_EMBY_DATA_DIR;
const workDirectory = process.env.JELLYPORT_SNAPSHOT_WORK_DIR;
if (
  !directory ||
  !source ||
  !workDirectory ||
  process.env.JELLYPORT_EMBY_VERSION !== SNAPSHOT_VERSION
)
  throw new Error(
    'Configure snapshot directory, local Emby data mount and supported Emby version.',
  );
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(workDirectory, { recursive: true, mode: 0o700 });
process.env.SQLITE_TMPDIR = workDirectory;
if (directory === workDirectory)
  throw new Error('The helper work directory must be separate from the snapshot exchange.');
async function sourceIdentity(serverId: string): Promise<void> {
  for (const [name, expected] of [
    ['lastversion.txt', SNAPSHOT_VERSION],
    ['device.txt', serverId],
  ]) {
    const path = join(source!, name!);
    await regular(path);
    if (
      (await lstat(path)).size > 128 ||
      (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim() !== expected
    )
      throw new Error('The mounted Emby identity or version does not match.');
  }
}
const heartbeat = setInterval(() => {
  void snapshotKey(directory)
    .then((key) =>
      writeEnvelope(
        join(directory, 'helper.status'),
        {
          version: 1,
          emby_version: SNAPSHOT_VERSION,
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
      recovered = true;
    }
    await writeEnvelope(
      join(directory, 'helper.status'),
      {
        version: 1,
        emby_version: SNAPSHOT_VERSION,
        updated_at: new Date().toISOString(),
      },
      key,
    );
    for (const name of await readdir(directory)) {
      if (stopping) break;
      if (!name.endsWith('.request') || !snapshotId.test(name.slice(0, -8))) continue;
      const id = name.slice(0, -8),
        path = join(directory, name);
      let request: CaptureRequest;
      try {
        request = await readEnvelope<CaptureRequest>(path, key);
        if (
          request.id !== id ||
          request.binding?.version !== SNAPSHOT_VERSION ||
          !Number.isFinite(Date.parse(request.requested_at)) ||
          Math.abs(Date.now() - Date.parse(request.requested_at)) > CAPTURE_DEADLINE
        )
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
        await sourceIdentity(request.binding.server_id);
        temporary = await mkdtemp(join(workDirectory, `capture-${id}-`));
        const output = join(temporary, 'library.db');
        const value = await snapshotProcess<{
          identities: Record<string, number>;
          schema: string;
          bytes: number;
        }>({ operation: 'capture', directory: source, output }, controller.signal);
        if (
          !request.user_ids?.length ||
          request.user_ids.length > 1000 ||
          request.user_ids.some(
            (id) => typeof id !== 'string' || !Object.hasOwn(value.identities, id),
          )
        )
          throw new Error('The mounted database does not contain the requested users.');
        await sourceIdentity(request.binding.server_id);
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
            'Database capture failed. Check the helper mount, version, permissions and WAL files. The last good capture is preserved.',
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
