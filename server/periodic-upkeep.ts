/** Independent maintenance lanes share a cadence and never overlap themselves. */
export function startPeriodicUpkeep(interval: number, tasks: ReadonlyArray<() => Promise<void>>) {
  const running = new Map<() => Promise<void>, Promise<void>>();
  const timer = setInterval(() => {
    for (const work of tasks) {
      if (running.has(work)) continue;
      const task = Promise.resolve()
        .then(work)
        .catch(() => {})
        .finally(() => {
          running.delete(work);
        });
      running.set(work, task);
    }
  }, interval);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.all(running.values());
  };
}
