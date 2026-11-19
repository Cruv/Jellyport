/** These errors contain only safe messages suitable for the administrator UI. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}
export class StripePriceReviewRequired extends ServiceError {
  constructor() {
    super(
      'The household was not covered by the current Stripe price review. Review its exact account slots before applying the tier reduction.',
    );
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
