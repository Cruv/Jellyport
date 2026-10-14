import { setTimeout as delay } from 'node:timers/promises';
import { MediaError } from './errors.js';

export type MediaReadOperation = 'catalog' | 'user_state' | 'playlists' | 'playlist_items';
const operations = new Set<MediaReadOperation>([
  'catalog',
  'user_state',
  'playlists',
  'playlist_items',
]);

export interface MediaWorkloadStats {
  calls: number;
  pages: number;
  items: number;
  cache_hits: number;
  cache_items: number;
  cancellations: number;
  failures: number;
  total_duration_ms: number;
  workload_duration_ms: number;
  active: number;
  queued: number;
  cooldown_remaining_ms: number;
}
/** Only fixed labels and aggregate numbers belong in these events. */
export interface MediaWorkloadEvent extends MediaWorkloadStats {
  event: 'read' | 'cache_hit' | 'canceled' | 'rejected';
  operation: MediaReadOperation;
  outcome: 'completed' | 'slow' | 'failed' | 'timeout' | 'canceled' | 'rejected';
  duration_ms: number;
}
interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
}

function canceled(): MediaError {
  return new MediaError('The source read was canceled.');
}
function coolingDown(): MediaError {
  return new MediaError(
    'Emby migration reads are paused after a slow, canceled or rejected request. Wait until the cooldown ends before retrying.',
  );
}
/** Bounds injected transports and sleepers even when they ignore cancellation. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw canceled();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(canceled());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Share one instance across source clients. A slow read stops the workload rather than
 * retrying it, and all requests leave an idle interval after their completion.
 * This protects admission; canceling HTTP cannot guarantee upstream work has stopped.
 */
export class MediaWorkload {
  readonly maxReadMs: number;
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  private readonly observe?: (event: MediaWorkloadEvent) => void;
  private readonly idleMs: number;
  private readonly slowMs: number;
  private readonly cooldownMs: number;
  private readonly maxQueued: number;
  private readonly lifetime = new AbortController();
  private readonly waiters: Waiter[] = [];
  private waitController?: AbortController;
  private active = false;
  private pumping = false;
  private nextAllowed = 0;
  private cooldownUntil = 0;
  private readonly startedAt: number;
  private readonly totals = {
    calls: 0,
    pages: 0,
    items: 0,
    cache_hits: 0,
    cache_items: 0,
    cancellations: 0,
    failures: 0,
    total_duration_ms: 0,
  };

  constructor(
    options: {
      clock?: () => number;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
      observe?: (event: MediaWorkloadEvent) => void;
      idleMs?: number;
      slowMs?: number;
      cooldownMs?: number;
      maxReadMs?: number;
      maxQueued?: number;
    } = {},
  ) {
    this.clock = options.clock ?? (() => performance.now());
    this.sleep =
      options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    this.observe = options.observe;
    this.idleMs = options.idleMs ?? 500;
    this.slowMs = options.slowMs ?? 2000;
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.maxReadMs = options.maxReadMs ?? 5000;
    this.maxQueued = options.maxQueued ?? 8;
    if (
      ![this.idleMs, this.slowMs, this.cooldownMs, this.maxReadMs].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      !Number.isSafeInteger(this.maxQueued) ||
      this.maxQueued < 1 ||
      this.maxQueued > 100
    )
      throw new MediaError('Invalid source workload configuration.');
    this.startedAt = this.clock();
  }

  snapshot(): MediaWorkloadStats {
    return {
      ...this.totals,
      workload_duration_ms: Math.max(0, this.clock() - this.startedAt),
      active: Number(this.active),
      queued: this.waiters.length,
      cooldown_remaining_ms: Math.max(0, this.cooldownUntil - this.clock()),
    };
  }

  private emit(
    operation: MediaReadOperation,
    event: MediaWorkloadEvent['event'],
    outcome: MediaWorkloadEvent['outcome'],
    durationMs = 0,
  ): void {
    try {
      this.observe?.({ ...this.snapshot(), operation, event, outcome, duration_ms: durationMs });
    } catch {
      // Observability must never cause a request, prevent cancellation, or change a result.
    }
  }

  private operation(value: MediaReadOperation): void {
    if (!operations.has(value)) throw new MediaError('Unsupported source workload operation.');
  }

  cacheHit(operation: MediaReadOperation, items = 0): void {
    this.operation(operation);
    this.totals.cache_hits++;
    if (Number.isSafeInteger(items) && items >= 0) this.totals.cache_items += items;
    this.emit(operation, 'cache_hit', 'completed');
  }

  close(): void {
    this.lifetime.abort();
    this.waitController?.abort();
    this.rejectWaiters(canceled());
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(error);
    }
  }

  private openCircuit(retryAfterMs = 0): void {
    const serverDelay = Number.isFinite(retryAfterMs)
      ? Math.min(86_400_000, Math.max(0, retryAfterMs))
      : 0;
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      this.clock() + Math.max(this.cooldownMs, serverDelay),
    );
    this.waitController?.abort();
    this.rejectWaiters(coolingDown());
  }

  private admit(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted || this.lifetime.signal.aborted) return Promise.reject(canceled());
    if (this.clock() < this.cooldownUntil) return Promise.reject(coolingDown());
    if (this.waiters.length >= this.maxQueued)
      return Promise.reject(new MediaError('Source migration reads are busy. Try again later.'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(canceled());
          if (!this.waiters.length) this.waitController?.abort();
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.active) return;
    this.pumping = true;
    try {
      while (this.waiters.length && !this.active) {
        if (this.lifetime.signal.aborted) {
          this.rejectWaiters(canceled());
          return;
        }
        if (this.clock() < this.cooldownUntil) {
          this.rejectWaiters(coolingDown());
          return;
        }
        const wait = this.nextAllowed - this.clock();
        if (wait > 0) {
          const controller = new AbortController();
          this.waitController = controller;
          try {
            await abortable(this.sleep(wait, controller.signal), controller.signal);
          } catch {
            if (!controller.signal.aborted) {
              this.rejectWaiters(new MediaError('Unable to schedule the source read.'));
              return;
            }
          } finally {
            if (this.waitController === controller) this.waitController = undefined;
          }
          continue;
        }
        const waiter = this.waiters.shift()!;
        waiter.signal?.removeEventListener('abort', waiter.abort);
        if (waiter.signal?.aborted) {
          waiter.reject(canceled());
          continue;
        }
        this.active = true;
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          this.active = false;
          this.nextAllowed = this.clock() + this.idleMs;
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  async read<T>(
    operation: MediaReadOperation,
    action: (signal: AbortSignal) => Promise<T>,
    options: {
      signal?: AbortSignal;
      items?: (value: T) => number;
      page?: boolean;
    } = {},
  ): Promise<T> {
    this.operation(operation);
    let release: () => void;
    try {
      release = await this.admit(options.signal);
    } catch (error) {
      if (options.signal?.aborted || this.lifetime.signal.aborted) {
        this.totals.cancellations++;
        this.emit(operation, 'canceled', 'canceled');
      } else this.emit(operation, 'rejected', 'rejected');
      throw error;
    }
    const timeout = new AbortController();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      timeout.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const timer = setTimeout(() => timeout.abort(), this.maxReadMs);
    timer.unref();
    const started = this.clock();
    let outcome: MediaWorkloadEvent['outcome'] = 'completed';
    let called = false;
    try {
      if (signal.aborted) throw canceled();
      called = true;
      this.totals.calls++;
      const value = await abortable(
        Promise.resolve().then(() => action(signal)),
        signal,
      );
      if (signal.aborted) throw canceled();
      if (this.clock() - started >= this.slowMs) {
        outcome = 'slow';
        throw new MediaError(
          'Emby responded slowly. The migration read was stopped to protect playback. Wait until the cooldown ends before retrying.',
        );
      }
      if (options.page !== false) this.totals.pages++;
      const items = options.items?.(value) ?? 0;
      if (Number.isSafeInteger(items) && items >= 0) this.totals.items += items;
      return value;
    } catch (error) {
      if (options.signal?.aborted || this.lifetime.signal.aborted) {
        outcome = 'canceled';
        this.totals.cancellations++;
        // The server may keep processing an accepted request after its client aborts.
        // A queued/idle cancellation made no request and does not need this hold.
        if (called && !this.lifetime.signal.aborted) this.openCircuit();
        throw canceled();
      }
      this.totals.failures++;
      if (timeout.signal.aborted) {
        outcome = 'timeout';
        this.openCircuit();
        throw new MediaError(
          'The Emby migration read timed out and was stopped to protect playback. Wait until the cooldown ends before retrying.',
        );
      }
      if (this.clock() - started >= this.slowMs) outcome = 'slow';
      else if (outcome !== 'slow') outcome = 'failed';
      // Missing HTTP status includes network failures and response-boundary failures.
      if (
        outcome === 'slow' ||
        !(error instanceof MediaError) ||
        error.statusCode === undefined ||
        error.statusCode === 429 ||
        error.statusCode >= 500
      )
        this.openCircuit(error instanceof MediaError ? error.retryAfterMs : 0);
      throw error;
    } finally {
      clearTimeout(timer);
      const duration = Math.max(0, this.clock() - started);
      if (called) this.totals.total_duration_ms += duration;
      release();
      this.emit(operation, outcome === 'canceled' ? 'canceled' : 'read', outcome, duration);
    }
  }
}
