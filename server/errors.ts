/** These errors contain only safe messages suitable for the administrator UI. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}
export class MediaError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    /** Sanitized server backoff hint; never retains the original response header. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}
