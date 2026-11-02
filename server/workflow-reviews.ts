import { randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';

/** Private, bounded, one-use review evidence. A route never trusts a browser's plan. */
export class WorkflowReviews<T> {
  private entries = new Map<
    string,
    { owner: string; context: string; expires: number; value: T }
  >();
  save(owner: string, context: string, value: T) {
    for (const [id, entry] of this.entries)
      if (entry.expires <= Date.now() || entry.owner === owner) this.entries.delete(id);
    if (this.entries.size >= 16 || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
      throw new ServiceError('Too many account reviews. Close an earlier review and try again.');
    const review_token = randomUUID();
    const expires = Date.now() + 5 * 60_000;
    this.entries.set(review_token, { owner, context, expires, value: structuredClone(value) });
    return { review_token, expires_at: new Date(expires).toISOString() };
  }
  take(owner: string, context: string, token: string): T {
    const entry = this.entries.get(token);
    if (!entry || entry.owner !== owner || entry.context !== context || entry.expires <= Date.now())
      throw new ServiceError('This account review expired or changed. Check the workflow again.');
    this.entries.delete(token);
    return structuredClone(entry.value);
  }
  cancelOwner(owner: string) {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id);
  }
  clear() {
    this.entries.clear();
  }
}
