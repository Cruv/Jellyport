import { lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotProcess } from './snapshot-process.js';
import { encryptDatabase, readEnvelope, writeEnvelope, snapshotId } from './snapshot-files.js';
import {
  DESTINATION_CATALOG_DEADLINE,
  DESTINATION_CATALOG_FORMAT,
  destinationCatalogPrefix,
  validDestinationRequest,
  validDestinationResult,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
} from './destination-catalog-files.js';

const requestName = /^jellyfin-([a-f0-9-]{36})\.request$/;
const failure =
  'Jellyfin backup import failed. Check the completed backup, mounted folder, version and permissions. The last good catalog is preserved.';
function observe(value: Record<string, unknown>): void {
  try {
    console.info(JSON.stringify({ event: 'destination_catalog_import', ...value }));
  } catch {}
}

export async function processDestinationCatalogRequest(
  name: string,
  exchange: string,
  work: string,
  backups: string | undefined,
  key: Buffer,
  signal: AbortSignal,
): Promise<boolean> {
  const match = requestName.exec(name);
  if (!match) return false;
  if (!snapshotId.test(match[1]!)) return true;
  const id = match[1]!,
    prefix = destinationCatalogPrefix(id),
    path = join(exchange, name);
  let request: DestinationCatalogRequest;
  try {
    request = await readEnvelope(path, key);
    if (
      !validDestinationRequest(request) ||
      request.id !== id ||
      Math.abs(Date.now() - Date.parse(request.requested_at)) > DESTINATION_CATALOG_DEADLINE
    )
      throw new Error('Invalid catalog request.');
    await rename(path, join(exchange, `${prefix}.working`));
  } catch {
    await rm(path, { force: true });
    return true;
  }
  const started_at = new Date().toISOString();
  observe({ outcome: 'started' });
  let temporary: string | undefined;
  let result: DestinationCatalogResult;
  try {
    if (!backups) throw new Error('Destination backup mount unavailable.');
    temporary = await mkdtemp(join(work, `capture-${id}-`));
    const output = join(temporary, 'catalog.db');
    const value = await snapshotProcess<{
      bytes: number;
      items: number;
      keys: number;
      backup_created_at: string;
      backup_fingerprint: string;
      server_version: string;
      backup_engine_version: string;
    }>(
      {
        operation: 'destination_capture',
        directory: backups,
        output,
        version: request.binding.version,
      },
      signal,
      DESTINATION_CATALOG_DEADLINE,
    );
    await encryptDatabase(output, join(exchange, `${prefix}.db.enc.pending`), key, id, signal);
    await rename(join(exchange, `${prefix}.db.enc.pending`), join(exchange, `${prefix}.db.enc`));
    result = {
      ...request,
      ...value,
      ok: true,
      started_at,
      finished_at: new Date().toISOString(),
      projection_format: DESTINATION_CATALOG_FORMAT,
    };
    if (!validDestinationResult(result)) throw new Error('Unsupported catalog result.');
  } catch {
    result = {
      ...request,
      ok: false,
      started_at,
      finished_at: new Date().toISOString(),
      error: failure,
    };
    await rm(join(exchange, `${prefix}.db.enc`), { force: true });
  } finally {
    await rm(join(exchange, `${prefix}.db.enc.pending`), { force: true });
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  await writeEnvelope(join(exchange, `${prefix}.result`), result, key);
  await rm(join(exchange, `${prefix}.working`), { force: true });
  observe({
    outcome: result.ok ? 'completed' : signal.aborted ? 'canceled' : 'failed',
    duration_ms: Date.parse(result.finished_at) - Date.parse(started_at),
    ...(result.ok ? { items: result.items, keys: result.keys, bytes: result.bytes } : {}),
  });
  return true;
}

export async function recoverDestinationCatalogHelper(
  exchange: string,
  key: Buffer,
): Promise<void> {
  for (const name of await readdir(exchange)) {
    const match = /^jellyfin-([a-f0-9-]{36})\.working$/.exec(name);
    if (!match || !snapshotId.test(match[1]!)) continue;
    const id = match[1]!,
      prefix = destinationCatalogPrefix(id);
    try {
      const request = await readEnvelope<DestinationCatalogRequest>(join(exchange, name), key);
      if (!validDestinationRequest(request) || request.id !== id)
        throw new Error('Invalid request.');
      let completed = false;
      try {
        const result = await readEnvelope<DestinationCatalogResult>(
          join(exchange, `${prefix}.result`),
          key,
        );
        const stat = await lstat(join(exchange, `${prefix}.db.enc`));
        completed =
          validDestinationResult(result) &&
          result.id === id &&
          JSON.stringify(result.binding) === JSON.stringify(request.binding) &&
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size === result.bytes! + 28;
      } catch {}
      if (!completed) {
        await rm(join(exchange, `${prefix}.db.enc`), { force: true });
        await writeEnvelope(
          join(exchange, `${prefix}.result`),
          {
            ...request,
            ok: false,
            started_at: request.requested_at,
            finished_at: new Date().toISOString(),
            error: 'Jellyfin backup import was interrupted. The last good catalog is preserved.',
          },
          key,
        );
      }
    } catch {
      // Invalid authenticated metadata cannot become a reusable catalog.
    }
    await rm(join(exchange, `${prefix}.db.enc.pending`), { force: true });
    await rm(join(exchange, name), { force: true });
  }
}
