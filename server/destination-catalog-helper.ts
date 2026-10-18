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
  DestinationCatalogError,
  destinationCatalogErrorCode,
  destinationCatalogFailureMessage,
  validDestinationDiagnostic,
  validDestinationProgress,
  type DestinationCatalogDiagnostic,
  type DestinationCatalogProgress,
  type DestinationCatalogStage,
  type DestinationCatalogRequest,
  type DestinationCatalogResult,
} from './destination-catalog-files.js';

const requestName = /^jellyfin-([a-f0-9-]{36})\.request$/;
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
  let diagnostic: DestinationCatalogDiagnostic = {
    stage: 'validating_backup',
    started_at,
    updated_at: started_at,
    source_rows: 0,
    provider_rows: 0,
    items: 0,
    keys: 0,
    bytes: 0,
  };
  let pending: DestinationCatalogDiagnostic | undefined;
  let publishing: Promise<void> | undefined;
  const progress = (value: DestinationCatalogDiagnostic) => {
    if (!validDestinationDiagnostic(value)) return;
    diagnostic = { ...value, started_at, updated_at: new Date().toISOString() };
    pending = diagnostic;
    if (!publishing)
      publishing = (async () => {
        while (pending) {
          const next = pending;
          pending = undefined;
          const message: DestinationCatalogProgress = { ...request, diagnostic: next };
          await writeEnvelope(join(exchange, `${prefix}.progress`), message, key);
        }
      })()
        .catch(() => {
          /* Progress failures cannot change import correctness. */
        })
        .finally(() => {
          publishing = undefined;
        });
  };
  const stage = (value: DestinationCatalogStage) => progress({ ...diagnostic, stage: value });
  stage('validating_backup');
  let temporary: string | undefined;
  let result: DestinationCatalogResult;
  try {
    if (!backups) throw new DestinationCatalogError('backup_missing');
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
      diagnostic?: DestinationCatalogDiagnostic;
    }>(
      {
        operation: 'destination_capture',
        directory: backups,
        output,
        version: request.binding.version,
      },
      signal,
      DESTINATION_CATALOG_DEADLINE,
      {
        onProgress: (value) => {
          if (validDestinationDiagnostic(value)) progress(value);
        },
      },
    );
    if (value.diagnostic && validDestinationDiagnostic(value.diagnostic))
      progress(value.diagnostic);
    const outputDiagnostic = {
      ...diagnostic,
      items: value.items,
      keys: value.keys,
      bytes: value.bytes,
    };
    if (!validDestinationDiagnostic(outputDiagnostic))
      throw new DestinationCatalogError('backup_invalid');
    diagnostic = outputDiagnostic;
    stage('encrypting');
    await encryptDatabase(output, join(exchange, `${prefix}.db.enc.pending`), key, id, signal);
    await rename(join(exchange, `${prefix}.db.enc.pending`), join(exchange, `${prefix}.db.enc`));
    stage('validating_catalog');
    result = {
      ...request,
      ...value,
      ok: true,
      started_at,
      finished_at: new Date().toISOString(),
      projection_format: DESTINATION_CATALOG_FORMAT,
      diagnostic,
    };
    if (!validDestinationResult(result)) throw new DestinationCatalogError('backup_invalid');
  } catch (error) {
    if (
      error instanceof DestinationCatalogError &&
      error.diagnostic &&
      validDestinationDiagnostic(error.diagnostic)
    )
      progress(error.diagnostic);
    const classified = destinationCatalogErrorCode(error);
    const error_code = signal.aborted
      ? 'canceled'
      : error instanceof DestinationCatalogError || classified === 'storage_error'
        ? classified
        : 'worker_failed';
    diagnostic = { ...diagnostic, updated_at: new Date().toISOString() };
    result = {
      ...request,
      ok: false,
      started_at,
      finished_at: new Date().toISOString(),
      error: `${destinationCatalogFailureMessage(error_code)} Any previously saved catalog is preserved.`,
      error_code,
      diagnostic,
    };
    await rm(join(exchange, `${prefix}.db.enc`), { force: true });
  } finally {
    // Flush and stop all progress writes before publishing the terminal result.
    // The app can then remove both files without a late observer recreating progress.
    while (publishing) await publishing;
    pending = undefined;
    await rm(join(exchange, `${prefix}.db.enc.pending`), { force: true });
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  await writeEnvelope(join(exchange, `${prefix}.result`), result, key);
  await rm(join(exchange, `${prefix}.working`), { force: true });
  observe({
    outcome: result.ok ? 'completed' : signal.aborted ? 'canceled' : 'failed',
    duration_ms: Date.parse(result.finished_at) - Date.parse(started_at),
    stage: diagnostic.stage,
    ...(result.error_code ? { error_code: result.error_code } : {}),
    source_rows: diagnostic.source_rows,
    provider_rows: diagnostic.provider_rows,
    items: diagnostic.items,
    keys: diagnostic.keys,
    bytes: diagnostic.bytes,
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
        const finished_at = new Date().toISOString();
        let diagnostic: DestinationCatalogDiagnostic | undefined;
        try {
          const progress = await readEnvelope<unknown>(join(exchange, `${prefix}.progress`), key);
          if (
            validDestinationProgress(progress) &&
            progress.id === request.id &&
            progress.requested_at === request.requested_at &&
            JSON.stringify(progress.binding) === JSON.stringify(request.binding)
          )
            diagnostic = { ...progress.diagnostic, updated_at: finished_at };
        } catch {
          /* Legacy work may have no progress envelope. */
        }
        await writeEnvelope(
          join(exchange, `${prefix}.result`),
          {
            ...request,
            ok: false,
            started_at: request.requested_at,
            finished_at,
            error:
              'Jellyfin backup import was interrupted. Any previously saved catalog is preserved.',
            error_code: 'interrupted',
            ...(diagnostic && validDestinationDiagnostic(diagnostic) ? { diagnostic } : {}),
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
