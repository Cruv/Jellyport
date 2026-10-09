import { randomUUID } from 'node:crypto';
import { MediaError, ServiceError } from './errors.js';
import type { MigrationScope } from './migration.js';

const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export interface PreviewTask<T> {
  id: string;
  status: 'running' | 'ready' | 'failed';
  progress: { processed: number; total: number };
  preview?: T;
  error?: string;
}
interface Entry<T> {
  owner: string;
  context: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  value: PreviewTask<T>;
}
interface Controls {
  signal: AbortSignal;
  progress: (processed: number, total: number) => void;
  migration_scope: MigrationScope;
}

/** Ephemeral, session-owned reads; never persisted or shared between administrator sessions. */
export class PreviewTasks<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly running = new Set<Entry<T>>();
  constructor(
    private readonly run: (ids: string[], controls: Controls) => Promise<T>,
    private readonly options: {
      deadlineMs?: number;
      retentionMs?: number;
      maxResultBytes?: number;
    } = {},
  ) {}

  start(
    owner: string,
    context: string,
    ids: string[],
    migrationScope: MigrationScope = 'complete',
  ): PreviewTask<T> {
    if (!['complete', 'watched_only'].includes(migrationScope))
      throw new ServiceError('Choose a valid migration scope.');
    if (
      [...this.entries.values()].some(
        (entry) => entry.owner === owner && entry.value.status === 'running',
      )
    )
      throw new ServiceError(
        'History matching is already running in this session. Wait or cancel it first.',
      );
    if (this.running.size >= 2)
      throw new ServiceError(
        'Two history previews are already running. Wait for one to finish and retry.',
      );
    // One retained result per session; completed entries are evicted before accepting more work.
    this.cancelOwner(owner);
    if (this.entries.size >= 16) {
      const oldest = [...this.entries.values()].find((entry) => entry.value.status !== 'running');
      if (oldest) this.remove(oldest);
    }
    const value: PreviewTask<T> = {
      id: randomUUID(),
      status: 'running',
      progress: { processed: 0, total: ids.length },
    };
    const entry: Entry<T> = {
      owner,
      context,
      controller: new AbortController(),
      timer: setTimeout(
        () => {
          this.fail(
            entry,
            'History matching timed out. Try fewer users or check your media servers.',
          );
          entry.controller.abort();
        },
        this.options.deadlineMs ?? 15 * 60_000,
      ),
      value,
    };
    entry.timer.unref();
    this.entries.set(value.id, entry);
    this.running.add(entry);
    // Return immediately; every poll is a separate, short authenticated request.
    void Promise.resolve()
      .then(() => {
        entry.controller.signal.throwIfAborted();
        return this.run([...ids], {
          migration_scope: migrationScope,
          signal: entry.controller.signal,
          progress: (processed, total) => {
            if (entry.controller.signal.aborted || entry.value.status !== 'running') return;
            if (
              total === ids.length &&
              Number.isInteger(processed) &&
              processed >= 0 &&
              processed <= total
            )
              entry.value.progress = { processed, total };
          },
        });
      })
      .then((preview) => {
        if (entry.controller.signal.aborted || this.entries.get(value.id) !== entry) return;
        if (
          Buffer.byteLength(JSON.stringify(preview)) >
          Math.min(this.options.maxResultBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES)
        )
          throw new ServiceError(
            'This history preview has too many details. Select fewer users and retry.',
          );
        entry.value = {
          ...entry.value,
          status: 'ready',
          preview,
          progress: { processed: ids.length, total: ids.length },
        };
        this.retain(entry);
      })
      .catch((error: unknown) => {
        if (entry.controller.signal.aborted || this.entries.get(value.id) !== entry) return;
        this.fail(
          entry,
          error instanceof MediaError || error instanceof ServiceError
            ? error.message
            : 'History matching failed. Check your media servers and retry.',
        );
      })
      .finally(() => this.running.delete(entry));
    return structuredClone(value);
  }

  get(owner: string, context: string, id: string): PreviewTask<T> | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return undefined;
    if (entry.context !== context) {
      this.remove(entry);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  cancel(owner: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return false;
    this.remove(entry);
    return true;
  }

  cancelOwner(owner: string): void {
    for (const entry of this.entries.values()) if (entry.owner === owner) this.remove(entry);
  }

  close(): void {
    for (const entry of this.entries.values()) this.remove(entry);
  }

  private fail(entry: Entry<T>, error: string): void {
    if (this.entries.get(entry.value.id) !== entry || entry.value.status !== 'running') return;
    entry.value = { ...entry.value, status: 'failed', error };
    this.retain(entry);
  }

  private retain(entry: Entry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.remove(entry), this.options.retentionMs ?? 10 * 60_000);
    entry.timer.unref();
  }

  private remove(entry: Entry<T>): void {
    clearTimeout(entry.timer);
    this.entries.delete(entry.value.id);
    entry.controller.abort();
  }
}
