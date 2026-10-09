import { afterEach, expect, it, vi } from 'vitest';
import { PreviewTasks } from '../server/preview-tasks.js';
import { MediaError } from '../server/errors.js';
import type { MigrationScope } from '../server/migration.js';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it.each([undefined, 'complete', 'watched_only'] as const)(
  'passes the selected migration scope (%s) to its isolated asynchronous runner',
  async (scope) => {
    const run = vi.fn(async (_ids: string[], controls: { migration_scope: MigrationScope }) => ({
      scope: controls.migration_scope,
    }));
    const tasks = new PreviewTasks(run);
    try {
      const task = tasks.start('owner', 'config', ['source'], scope);
      expect(run).not.toHaveBeenCalled();
      await flush();
      expect(run).toHaveBeenCalledWith(
        ['source'],
        expect.objectContaining({ migration_scope: scope ?? 'complete' }),
      );
      expect(tasks.get('owner', 'config', task.id)?.preview).toEqual({
        scope: scope ?? 'complete',
      });
      expect(tasks.get('other-owner', 'config', task.id)).toBeUndefined();
      expect(tasks.cancel('other-owner', task.id)).toBe(false);
    } finally {
      tasks.close();
    }
  },
);

it('rejects invalid migration scopes before starting any work', async () => {
  const run = vi.fn(async () => 'unreachable');
  const tasks = new PreviewTasks(run);
  try {
    expect(() => tasks.start('owner', 'config', ['source'], 'invalid' as never)).toThrow(
      'Choose a valid migration scope.',
    );
    await flush();
    expect(run).not.toHaveBeenCalled();
  } finally {
    tasks.close();
  }
});

it.each([undefined, false, true])(
  'forwards snapshot selection %s without changing session ownership',
  async (useSnapshots) => {
    const run = vi.fn(async (_ids: string[], controls: { use_snapshots: boolean }) => ({
      use_snapshots: controls.use_snapshots,
    }));
    const tasks = new PreviewTasks(run);
    try {
      const task = tasks.start('owner', 'config', ['source'], 'complete', useSnapshots);
      await flush();
      expect(run).toHaveBeenCalledWith(
        ['source'],
        expect.objectContaining({ use_snapshots: useSnapshots ?? false }),
      );
      expect(tasks.get('owner', 'config', task.id)?.preview).toEqual({
        use_snapshots: useSnapshots ?? false,
      });
      expect(tasks.get('other', 'config', task.id)).toBeUndefined();
    } finally {
      tasks.close();
    }
  },
);

it('returns before scanning, keeps progress and results private to the requesting session, and returns copies', async () => {
  let release!: (value: { users: string[] }) => void;
  let report!: (processed: number, total: number) => void;
  const tasks = new PreviewTasks(async (_ids, controls) => {
    report = controls.progress;
    return new Promise<{ users: string[] }>((resolve) => {
      release = resolve;
    });
  });
  const initial = tasks.start('session-a', 'config-a', ['a', 'b']);
  expect(initial).toMatchObject({ status: 'running', progress: { processed: 0, total: 2 } });
  expect(initial.preview).toBeUndefined();
  expect(JSON.stringify(initial)).not.toContain('session-a');
  await flush();
  report(1, 2);
  expect(tasks.get('session-a', 'config-a', initial.id)?.progress.processed).toBe(1);
  expect(tasks.get('session-b', 'config-a', initial.id)).toBeUndefined();
  expect(tasks.cancel('session-b', initial.id)).toBe(false);
  release({ users: ['private-history'] });
  await flush();
  const ready = tasks.get('session-a', 'config-a', initial.id)!;
  expect(ready).toMatchObject({ status: 'ready', preview: { users: ['private-history'] } });
  ready.preview!.users.length = 0;
  expect(tasks.get('session-a', 'config-a', initial.id)?.preview?.users).toEqual([
    'private-history',
  ]);
  tasks.close();
});

it('sanitizes unexpected failures while preserving safe upstream diagnostics', async () => {
  const tasks = new PreviewTasks(async (ids) => {
    if (ids[0] === 'safe') throw new MediaError('Emby request timed out.');
    throw new Error('credential=private-token server-path=/private/data');
  });
  const raw = tasks.start('a', 'config', ['raw']);
  await flush();
  expect(tasks.get('a', 'config', raw.id)?.error).toBe(
    'History matching failed. Check your media servers and retry.',
  );
  const safe = tasks.start('b', 'config', ['safe']);
  await flush();
  expect(tasks.get('b', 'config', safe.id)?.error).toBe('Emby request timed out.');
  tasks.close();
});

it('aborts at the deadline, ignores a late result, and expires retained data', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  let release!: (value: string) => void;
  const tasks = new PreviewTasks(
    async (_ids, controls) => {
      signal = controls.signal;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
    { deadlineMs: 1000, retentionMs: 2000 },
  );
  const task = tasks.start('a', 'config', ['user']);
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  expect(signal.aborted).toBe(true);
  expect(tasks.get('a', 'config', task.id)?.status).toBe('failed');
  release('late-private-history');
  await flush();
  expect(tasks.get('a', 'config', task.id)?.preview).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000);
  expect(tasks.get('a', 'config', task.id)).toBeUndefined();
  tasks.close();
});

it('cancels only the owner’s work and invalidates a result when configuration changes', async () => {
  const signals: AbortSignal[] = [];
  const tasks = new PreviewTasks(async (_ids, { signal }) => {
    signals.push(signal);
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
    return 'unreachable';
  });
  const a = tasks.start('a', 'config', ['a']);
  const b = tasks.start('b', 'config', ['b']);
  await flush();
  tasks.cancelOwner('a');
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  expect(tasks.get('a', 'config', a.id)).toBeUndefined();
  expect(tasks.get('b', 'different-config', b.id)).toBeUndefined();
  expect(signals[1]!.aborted).toBe(true);
  await flush();
  tasks.close();
});

it('bounds concurrent scans, duplicate owner requests, and retained results', async () => {
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tasks = new PreviewTasks(async () => {
    await barrier;
    return 'history';
  });
  tasks.start('a', 'config', ['a']);
  expect(() => tasks.start('a', 'config', ['a'])).toThrow('already running in this session');
  tasks.start('b', 'config', ['b']);
  expect(() => tasks.start('c', 'config', ['c'])).toThrow('Two history previews');
  finish();
  await flush();
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    ids.push(tasks.start(`owner-${i}`, 'config', ['user']).id);
    await flush();
  }
  expect(tasks.get('owner-0', 'config', ids[0]!)).toBeUndefined();
  expect(tasks.get('owner-19', 'config', ids[19]!)?.status).toBe('ready');
  tasks.close();
  expect(tasks.get('owner-19', 'config', ids[19]!)).toBeUndefined();
});

it('rejects oversized preview results without retaining or returning their data', async () => {
  const tasks = new PreviewTasks(async () => ({ privateHistory: 'x'.repeat(1024) }), {
    maxResultBytes: 100,
  });
  const task = tasks.start('owner', 'config', ['user']);
  await flush();
  expect(tasks.get('owner', 'config', task.id)).toMatchObject({
    status: 'failed',
    error: 'This history preview has too many details. Select fewer users and retry.',
  });
  expect(tasks.get('owner', 'config', task.id)?.preview).toBeUndefined();
  tasks.close();
});
