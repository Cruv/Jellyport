import { createHash } from 'node:crypto';
import { MediaError } from './errors.js';
import type { MediaItem } from './media.js';

export interface MigrationCatalog {
  readonly items: MediaItem[];
  readonly capturedAt: number;
}

/** Metadata only. Personal state is never admitted to, or served from, this cache. */
export class MigrationCatalogCache {
  private entry?: { key: string; value: MigrationCatalog };
  private pending?: { key: string; value: Promise<MigrationCatalog> };
  private epoch = 0;
  constructor(
    private readonly options: {
      clock?: () => number;
      ttlMs?: number;
      hit?: (items: number) => void;
    } = {},
  ) {}

  static key(url: string, apiKey: string, serverId: string, version: string): string {
    return createHash('sha256')
      .update(JSON.stringify([new URL(url).toString(), apiKey, serverId, version]))
      .digest('hex');
  }

  async get(key: string, load: () => Promise<MediaItem[]>): Promise<MigrationCatalog> {
    const clock = this.options.clock ?? Date.now;
    if (
      this.entry?.key === key &&
      clock() - this.entry.value.capturedAt < (this.options.ttlMs ?? 600_000)
    ) {
      this.options.hit?.(this.entry.value.items.length);
      return this.entry.value;
    }
    if (this.pending) {
      // Service serializes live migrations. Reject conflicting builds rather than
      // retain multiple large indexes or launch work for an obsolete connection.
      if (this.pending.key !== key)
        throw new MediaError('Another source catalog is being prepared. Wait and retry.');
      this.options.hit?.(0);
      return this.pending.value;
    }
    this.entry = undefined;
    const epoch = this.epoch;
    // Record the beginning of collection, not its end: this is a bounded-age
    // matching view, never a claim to an atomic live library snapshot.
    const capturedAt = clock();
    const pending = Promise.resolve()
      .then(load)
      .then((items): MigrationCatalog => {
        let bytes = 0;
        if (items.length > 200_000)
          throw new MediaError(
            'The source matching catalog exceeds the supported item limit. Use a saved snapshot.',
          );
        for (const item of items) {
          if (Object.hasOwn(item, 'UserData'))
            throw new MediaError('Personal state cannot be stored in the matching catalog.');
          bytes += Buffer.byteLength(JSON.stringify(item));
          if (bytes > 64 * 1024 * 1024)
            throw new MediaError(
              'The source matching catalog exceeds the supported memory budget. Use a saved snapshot.',
            );
          for (const value of Object.values(item))
            if (value && typeof value === 'object') Object.freeze(value);
          Object.freeze(item);
        }
        const value = { items: Object.freeze(items) as unknown as MediaItem[], capturedAt };
        if (this.epoch === epoch) this.entry = { key, value };
        return value;
      });
    this.pending = { key, value: pending };
    try {
      return await pending;
    } finally {
      if (this.pending?.value === pending) this.pending = undefined;
    }
  }

  clear(): void {
    this.epoch++;
    this.entry = undefined;
  }
}
