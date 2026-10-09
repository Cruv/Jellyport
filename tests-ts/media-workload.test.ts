import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaError } from '../server/errors.js';
import { MediaWorkload, type MediaWorkloadEvent } from '../server/media-workload.js';

const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let time = 0;
  const sleeps: number[] = [];
  const events: MediaWorkloadEvent[] = [];
  const workload = new MediaWorkload({
    clock: () => time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    observe: (event) => events.push(event),
  });
  return {
    workload,
    events,
    sleeps,
    now: () => time,
    advance: (milliseconds: number) => (time += milliseconds),
  };
}
afterEach(() => vi.useRealTimers());

describe('source migration workload admission', () => {
  it('serializes clients and leaves 500 ms idle after completion, including time spent reading', async () => {
    const { workload, advance, now, sleeps } = fixture();
    const first = deferred<string>();
    const starts: number[] = [];
    const one = workload.read('catalog', async () => {
      starts.push(now());
      advance(900);
      return first.promise;
    });
    await flush();
    const two = workload.read('user_state', async () => {
      starts.push(now());
      advance(100);
      return 'two';
    });
    const three = workload.read('playlist_items', async () => {
      starts.push(now());
      return 'three';
    });
    await flush();
    expect(starts).toEqual([0]);
    expect(workload.snapshot()).toMatchObject({ active: 1, queued: 2, calls: 1 });
    first.resolve('one');
    expect(await Promise.all([one, two, three])).toEqual(['one', 'two', 'three']);
    expect(starts).toEqual([0, 1400, 2000]);
    expect(sleeps).toEqual([500, 500]);
    expect(workload.snapshot()).toMatchObject({ active: 0, queued: 0, calls: 3, pages: 3 });
    workload.close();
  });

  it('cancels queued admission promptly without waiting for the active read or leaking a permit', async () => {
    const { workload } = fixture();
    const first = deferred<number>();
    const one = workload.read('catalog', () => first.promise);
    await flush();
    const controller = new AbortController();
    const action = vi.fn(async () => 2);
    const two = workload.read('user_state', action, { signal: controller.signal });
    const canceled = expect(two).rejects.toThrow('canceled');
    controller.abort();
    await canceled;
    expect(action).not.toHaveBeenCalled();
    expect(workload.snapshot()).toMatchObject({ active: 1, queued: 0, cancellations: 1 });
    first.resolve(1);
    expect(await one).toBe(1);
    expect(await workload.read('user_state', async () => 3)).toBe(3);
    workload.close();
  });

  it('does not call an already canceled request or install an idle sleeper', async () => {
    const { workload, sleeps } = fixture();
    const controller = new AbortController();
    controller.abort();
    const action = vi.fn(async () => 1);
    await expect(workload.read('catalog', action, { signal: controller.signal })).rejects.toThrow(
      'canceled',
    );
    expect(action).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
    expect(workload.snapshot()).toMatchObject({ calls: 0, active: 0, queued: 0 });
    workload.close();
  });

  it('cancels in-flight work even if an injected transport ignores its signal', async () => {
    const { workload, advance } = fixture();
    const ignored = deferred<number>();
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const request = workload.read(
      'catalog',
      (signal) => {
        transportSignal = signal;
        return ignored.promise;
      },
      { signal: controller.signal },
    );
    const canceled = expect(request).rejects.toThrow('canceled');
    await flush();
    controller.abort();
    await canceled;
    expect(transportSignal?.aborted).toBe(true);
    expect(workload.snapshot()).toMatchObject({
      active: 0,
      cancellations: 1,
      failures: 0,
      cooldown_remaining_ms: 300_000,
    });
    const retry = vi.fn(async () => 'next');
    await expect(workload.read('catalog', retry)).rejects.toThrow('paused');
    expect(retry).not.toHaveBeenCalled();
    ignored.resolve(1);
    await flush();
    advance(299_999);
    await expect(workload.read('catalog', retry)).rejects.toThrow('paused');
    advance(1);
    expect(await workload.read('catalog', retry)).toBe('next');
    expect(workload.snapshot().calls).toBe(2);
    workload.close();
  });

  it('cancels the last waiter during an idle interval and never starts its action', async () => {
    let time = 0;
    const sleeping = deferred<void>();
    let sleeperSignal: AbortSignal | undefined;
    const workload = new MediaWorkload({
      clock: () => time,
      sleep: async (_milliseconds, signal) => {
        sleeperSignal = signal;
        return sleeping.promise;
      },
    });
    await workload.read('catalog', async () => 'first');
    const controller = new AbortController();
    const action = vi.fn(async () => 'second');
    const next = workload.read('catalog', action, { signal: controller.signal });
    const canceled = expect(next).rejects.toThrow('canceled');
    await flush();
    controller.abort();
    await canceled;
    expect(sleeperSignal?.aborted).toBe(true);
    expect(action).not.toHaveBeenCalled();
    time = 500;
    expect(await workload.read('catalog', async () => 'third')).toBe('third');
    sleeping.resolve();
    workload.close();
  });

  it('bounds admission memory and does not start rejected queued reads', async () => {
    const workload = new MediaWorkload({ maxQueued: 1, sleep: async () => {} });
    const first = deferred<number>();
    const one = workload.read('catalog', () => first.promise);
    await flush();
    const controller = new AbortController();
    const second = workload.read('catalog', async () => 2, { signal: controller.signal });
    const secondCanceled = expect(second).rejects.toThrow('canceled');
    const action = vi.fn(async () => 3);
    await expect(workload.read('catalog', action)).rejects.toThrow('busy');
    expect(action).not.toHaveBeenCalled();
    expect(workload.snapshot().queued).toBe(1);
    controller.abort();
    await secondCanceled;
    first.resolve(1);
    await one;
    workload.close();
  });

  it('a two-second response opens the circuit and rejects all queued reads without retrying', async () => {
    const { workload, advance } = fixture();
    const result = deferred<number>();
    const one = workload.read('catalog', () => result.promise);
    const slow = expect(one).rejects.toThrow('responded slowly');
    await flush();
    const action = vi.fn(async () => 2);
    const queued = workload.read('user_state', action);
    const rejected = expect(queued).rejects.toThrow('paused');
    advance(2000);
    result.resolve(1);
    await Promise.all([slow, rejected]);
    expect(action).not.toHaveBeenCalled();
    expect(workload.snapshot()).toMatchObject({
      calls: 1,
      failures: 1,
      pages: 0,
      queued: 0,
      cooldown_remaining_ms: 300_000,
    });
    await expect(workload.read('catalog', action)).rejects.toThrow('paused');
    advance(299_999);
    await expect(workload.read('catalog', action)).rejects.toThrow('paused');
    advance(1);
    expect(await workload.read('catalog', action)).toBe(2);
    expect(action).toHaveBeenCalledTimes(1);
    workload.close();
  });

  it.each([429, 500, 503, undefined])(
    'opens a cooldown on HTTP/network failure %j',
    async (status) => {
      const { workload } = fixture();
      const action = vi.fn(async () => {
        if (status === undefined) throw new Error('secret transport details');
        throw new MediaError('Request rejected.', status);
      });
      await expect(workload.read('catalog', action)).rejects.toThrow();
      await expect(workload.read('catalog', action)).rejects.toThrow('paused');
      expect(action).toHaveBeenCalledTimes(1);
      expect(workload.snapshot()).toMatchObject({
        calls: 1,
        failures: 1,
        cooldown_remaining_ms: 300_000,
      });
      workload.close();
    },
  );

  it('does not open a circuit on a quick not-found response', async () => {
    const { workload } = fixture();
    await expect(
      workload.read('catalog', async () => {
        throw new MediaError('Not found.', 404);
      }),
    ).rejects.toThrow('Not found');
    expect(workload.snapshot().cooldown_remaining_ms).toBe(0);
    expect(await workload.read('catalog', async () => 'next')).toBe('next');
    workload.close();
  });

  it.each([
    [600_000, 600_000],
    [86_400_001, 86_400_000],
    [-1, 300_000],
    [Number.NaN, 300_000],
  ])(
    'honors bounded server Retry-After %j without shortening the default cooldown',
    async (hint, expected) => {
      const { workload, advance } = fixture();
      await expect(
        workload.read('catalog', async () => {
          throw new MediaError('Request rejected.', 429, hint);
        }),
      ).rejects.toThrow('Request rejected');
      expect(workload.snapshot().cooldown_remaining_ms).toBe(expected);
      const retry = vi.fn(async () => 'next');
      advance(expected - 1);
      await expect(workload.read('catalog', retry)).rejects.toThrow('paused');
      expect(retry).not.toHaveBeenCalled();
      advance(1);
      expect(await workload.read('catalog', retry)).toBe('next');
      workload.close();
    },
  );

  it('rejects queued requests when an active cancellation may leave upstream work running', async () => {
    const { workload } = fixture();
    const controller = new AbortController();
    const lingering = deferred<string>();
    const active = workload.read('catalog', () => lingering.promise, { signal: controller.signal });
    const canceled = expect(active).rejects.toThrow('canceled');
    await flush();
    const queuedAction = vi.fn(async () => 'queued');
    const queued = workload.read('user_state', queuedAction);
    const rejected = expect(queued).rejects.toThrow('paused');
    controller.abort();
    await Promise.all([canceled, rejected]);
    expect(queuedAction).not.toHaveBeenCalled();
    expect(workload.snapshot()).toMatchObject({
      calls: 1,
      queued: 0,
      cooldown_remaining_ms: 300_000,
    });
    lingering.resolve('late');
    workload.close();
  });

  it('also pauses after a slow response that is normally a non-circuit HTTP error', async () => {
    const { workload, advance } = fixture();
    await expect(
      workload.read('catalog', async () => {
        advance(2000);
        throw new MediaError('Not found.', 404);
      }),
    ).rejects.toThrow('Not found');
    expect(workload.snapshot().cooldown_remaining_ms).toBe(300_000);
    await expect(workload.read('catalog', async () => 'next')).rejects.toThrow('paused');
    workload.close();
  });

  it('enforces a five-second deadline and aborts the transport without queuing retries', async () => {
    vi.useFakeTimers();
    const workload = new MediaWorkload();
    let signal: AbortSignal | undefined;
    const action = vi.fn(async (value: AbortSignal) => {
      signal = value;
      return new Promise(() => {});
    });
    const request = workload.read('catalog', action);
    const timedOut = expect(request).rejects.toThrow('timed out');
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(signal?.aborted).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(workload.snapshot()).toMatchObject({
      active: 0,
      failures: 1,
      cooldown_remaining_ms: 300_000,
    });
    await expect(workload.read('catalog', action)).rejects.toThrow('paused');
    workload.close();
  });

  it('close cancels active work and waiters and rejects new work', async () => {
    const { workload } = fixture();
    const one = workload.read('catalog', async () => new Promise(() => {}));
    const oneCanceled = expect(one).rejects.toThrow('canceled');
    await flush();
    const action = vi.fn(async () => 2);
    const two = workload.read('catalog', action);
    const twoCanceled = expect(two).rejects.toThrow('canceled');
    workload.close();
    await Promise.all([oneCanceled, twoCanceled]);
    await expect(workload.read('catalog', action)).rejects.toThrow('canceled');
    expect(action).not.toHaveBeenCalled();
    expect(workload.snapshot()).toMatchObject({ calls: 1, active: 0, queued: 0, cancellations: 3 });
  });

  it('reports fixed aggregate metrics without transporting private data or observer failures', async () => {
    const { workload, advance, events } = fixture();
    const privateValue = {
      username: 'PRIVATE_USER',
      title: 'PRIVATE_TITLE',
      token: 'PRIVATE_TOKEN',
    };
    expect(
      await workload.read(
        'catalog',
        async () => {
          advance(27);
          return [privateValue, privateValue];
        },
        { items: (values) => values.length },
      ),
    ).toEqual([privateValue, privateValue]);
    workload.cacheHit('catalog', 2);
    expect(workload.snapshot()).toMatchObject({
      calls: 1,
      pages: 1,
      items: 2,
      cache_hits: 1,
      cache_items: 2,
      total_duration_ms: 27,
    });
    expect(events[0]).toMatchObject({
      operation: 'catalog',
      event: 'read',
      duration_ms: 27,
      items: 2,
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    expect(() => workload.cacheHit('PRIVATE_TOKEN' as never)).toThrow('Unsupported');
    workload.close();
    const failingObserver = new MediaWorkload({
      observe: () => {
        throw new Error('observer');
      },
    });
    expect(await failingObserver.read('catalog', async () => 1)).toBe(1);
    failingObserver.close();
  });
});
