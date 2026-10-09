import { randomUUID } from 'node:crypto';
import { isObject, type FetchTransport } from './media.js';

const MAX_RESPONSE_BYTES = 1_048_576;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Safe authentication failures; never attach the upstream response, URL, or credentials. */
export class JellyfinAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'JellyfinAuthError';
  }
}

export interface JellyfinIdentity {
  serverId: string;
  userId: string;
  username: string;
  accessToken: string;
}

export interface JellyfinAuthentication {
  authenticate(
    baseUrl: string,
    username: string,
    password: string,
    expectedServerId?: string,
  ): Promise<JellyfinIdentity>;
  validateSession(
    baseUrl: string,
    accessToken: string,
    expectedServerId: string,
    expectedUserId: string,
  ): Promise<JellyfinIdentity>;
  signOut(baseUrl: string, accessToken: string): Promise<void>;
  createApiKey(baseUrl: string, adminToken: string, appName: string): Promise<string>;
  deleteApiKey(baseUrl: string, adminToken: string, apiKey: string): Promise<void>;
}

export interface JellyfinAuthClientOptions {
  transport?: FetchTransport;
  timeoutMs?: number;
  /** A safe installation prefix; every authentication still gets a unique device ID. */
  deviceId?: string;
}

export function normalizeJellyfinUrl(value: string): string {
  const message =
    'Jellyfin URL must be an HTTP(S) address without credentials, query parameters, or fragments.';
  try {
    if (
      typeof value !== 'string' ||
      value.length > 2048 ||
      CONTROL_CHARACTERS.test(value) ||
      /[\\?#]/.test(value)
    )
      throw new Error();
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new JellyfinAuthError(message, 400);
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function token(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[a-zA-Z0-9._~+\/-]+$/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function invalidResponse(): JellyfinAuthError {
  return new JellyfinAuthError('Jellyfin returned an unexpected authentication response.', 502);
}

function administrator(
  value: unknown,
  expectedServerId: string,
): { userId: string; username: string } {
  if (
    !isObject(value) ||
    !identifier(value.Id) ||
    !identifier(value.Name) ||
    (value.ServerId !== undefined && value.ServerId !== expectedServerId)
  )
    throw invalidResponse();
  if (
    !isObject(value.Policy) ||
    value.Policy.IsAdministrator !== true ||
    value.Policy.IsDisabled !== false
  )
    throw new JellyfinAuthError('An enabled Jellyfin administrator account is required.', 403);
  return { userId: value.Id, username: value.Name };
}

/** Also bounds injected transports and response streams that do not observe fetch cancellation. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Authentication request timed out.');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Authentication request timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function cancelBody(response: Response | undefined): void {
  // Never wait on cancellation supplied by a remote or custom response stream.
  if (response?.body) void response.body.cancel().catch(() => {});
}

/** Passwords are submitted once to Jellyfin, and only the returned token leaves this client. */
export class JellyfinAuthClient implements JellyfinAuthentication {
  private readonly transport: FetchTransport;
  private readonly timeoutMs: number;
  private readonly devicePrefix: string;

  constructor(options: JellyfinAuthClientOptions = {}) {
    this.transport = options.transport ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.devicePrefix = options.deviceId ?? 'jellyport';
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 60_000 ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(this.devicePrefix)
    )
      throw new JellyfinAuthError('Invalid Jellyfin authentication client configuration.', 400);
  }

  private async request(
    baseUrl: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: {
      accessToken?: string;
      body?: unknown;
      deviceId?: string;
      params?: Record<string, string>;
      decode?: boolean;
    } = {},
  ): Promise<unknown> {
    const address = new URL(`${normalizeJellyfinUrl(baseUrl)}/${path}`);
    for (const [name, value] of Object.entries(options.params ?? {}))
      address.searchParams.set(name, value);
    if (options.accessToken !== undefined && !token(options.accessToken))
      throw new JellyfinAuthError('The Jellyfin session is invalid. Sign in again.', 401);
    const controller = new AbortController();
    const deadline = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const pending = this.transport(address.toString(), {
        method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Jellyport/0.3.0',
          ...(options.deviceId || options.accessToken
            ? {
                Authorization: options.deviceId
                  ? `MediaBrowser Client="Jellyport", Device="Jellyport", DeviceId="${options.deviceId}", Version="0.3.0"`
                  : `MediaBrowser Token="${options.accessToken}"`,
              }
            : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      // Custom transports can resolve after their deadline; dispose of any late body.
      void pending.then(
        (late) => {
          if (controller.signal.aborted) cancelBody(late);
        },
        () => {},
      );
      response = await abortable(pending, controller.signal);
      if (!response.ok) {
        if (response.status === 401)
          throw new JellyfinAuthError(
            'Jellyfin rejected the credentials or session. Sign in again.',
            401,
          );
        if (response.status === 403)
          throw new JellyfinAuthError(
            'An enabled Jellyfin administrator account is required.',
            403,
          );
        throw new JellyfinAuthError('Jellyfin rejected the authentication request.', 502);
      }
      if (options.decode === false || response.status === 204) return undefined;
      const declaredLength = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
        throw invalidResponse();
      if (!response.body) throw invalidResponse();
      reader = response.body.getReader();
      let buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RESPONSE_BYTES));
      let bytes = 0;
      while (true) {
        // Empty or immediately available chunks cannot starve the timeout callback.
        if (Date.now() >= deadline) {
          controller.abort();
          throw controller.signal.reason;
        }
        const chunk = await abortable(reader.read(), controller.signal);
        if (chunk.done) break;
        const nextSize = bytes + chunk.value.byteLength;
        if (nextSize > MAX_RESPONSE_BYTES) throw invalidResponse();
        if (nextSize > buffer.length) {
          const expanded = Buffer.allocUnsafe(
            Math.min(MAX_RESPONSE_BYTES, Math.max(nextSize, buffer.length * 2)),
          );
          buffer.copy(expanded, 0, 0, bytes);
          buffer = expanded;
        }
        buffer.set(chunk.value, bytes);
        bytes = nextSize;
      }
      let result: unknown;
      try {
        result = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
      } catch {
        throw invalidResponse();
      }
      if (Date.now() >= deadline) {
        controller.abort();
        throw controller.signal.reason;
      }
      return result;
    } catch (error) {
      if (error instanceof JellyfinAuthError) throw error;
      throw new JellyfinAuthError(
        controller.signal.aborted
          ? 'The Jellyfin authentication request timed out.'
          : 'Unable to connect to Jellyfin. Check the server address and availability.',
        502,
      );
    } finally {
      clearTimeout(timer);
      // Do not await cancellation: a stalled custom response must not bypass the deadline.
      if (reader) {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          /* A canceled read may still be settling. */
        }
      } else cancelBody(response);
    }
  }

  async authenticate(
    baseUrl: string,
    username: string,
    password: string,
    expectedServerId?: string,
  ): Promise<JellyfinIdentity> {
    normalizeJellyfinUrl(baseUrl);
    if (!identifier(username) || typeof password !== 'string' || password.length > 4096)
      throw new JellyfinAuthError('A valid Jellyfin username and password are required.', 400);
    if (expectedServerId !== undefined && !identifier(expectedServerId))
      throw new JellyfinAuthError('The linked Jellyfin server identifier is invalid.', 400);
    // Fingerprint before submitting a password, so an existing installation cannot authenticate
    // to an unrelated server that happens to appear at its previously configured address.
    const info = await this.request(baseUrl, 'GET', 'System/Info/Public');
    if (!isObject(info) || !identifier(info.Id)) throw invalidResponse();
    if (expectedServerId !== undefined && info.Id !== expectedServerId)
      throw new JellyfinAuthError(
        'The connected Jellyfin server does not match this installation.',
        502,
      );
    const result = await this.request(baseUrl, 'POST', 'Users/AuthenticateByName', {
      body: { Username: username, Pw: password },
      // Jellyfin revokes earlier tokens for the same user/device ID on each authentication.
      deviceId: `${this.devicePrefix}-${randomUUID()}`,
    });
    const accessToken =
      isObject(result) && token(result.AccessToken) ? result.AccessToken : undefined;
    try {
      if (!isObject(result) || !accessToken || !identifier(result.ServerId))
        throw invalidResponse();
      if (result.ServerId !== info.Id) throw invalidResponse();
      const user = administrator(result.User, result.ServerId);
      return await this.currentIdentity(baseUrl, accessToken, result.ServerId, user.userId);
    } catch (error) {
      // A rejected nonadministrator login must not leave its newly issued Jellyfin token behind.
      if (accessToken) await this.signOut(baseUrl, accessToken).catch(() => {});
      throw error;
    }
  }

  async validateSession(
    baseUrl: string,
    accessToken: string,
    expectedServerId: string,
    expectedUserId: string,
  ): Promise<JellyfinIdentity> {
    if (!identifier(expectedServerId) || !identifier(expectedUserId) || !token(accessToken))
      throw new JellyfinAuthError('The Jellyfin session is invalid. Sign in again.', 401);
    // Check the pinned server before sending its token, including after a server URL changes.
    const info = await this.request(baseUrl, 'GET', 'System/Info/Public');
    if (!isObject(info) || !identifier(info.Id) || info.Id !== expectedServerId)
      throw new JellyfinAuthError(
        'The connected Jellyfin server does not match this installation.',
        502,
      );
    return this.currentIdentity(baseUrl, accessToken, expectedServerId, expectedUserId);
  }

  private async currentIdentity(
    baseUrl: string,
    accessToken: string,
    expectedServerId: string,
    expectedUserId: string,
  ): Promise<JellyfinIdentity> {
    const current = administrator(
      await this.request(baseUrl, 'GET', 'Users/Me', { accessToken }),
      expectedServerId,
    );
    if (current.userId !== expectedUserId)
      throw new JellyfinAuthError(
        'The Jellyfin session does not match its administrator account.',
        401,
      );
    return { serverId: expectedServerId, ...current, accessToken };
  }

  async signOut(baseUrl: string, accessToken: string): Promise<void> {
    await this.request(baseUrl, 'POST', 'Sessions/Logout', { accessToken, decode: false });
  }

  async createApiKey(baseUrl: string, adminToken: string, appName: string): Promise<string> {
    if (!identifier(appName) || appName !== appName.trim())
      throw new JellyfinAuthError('A valid Jellyport API key name is required.', 400);
    await this.request(baseUrl, 'POST', 'Auth/Keys', {
      accessToken: adminToken,
      params: { app: appName },
      decode: false,
    });
    // Jellyfin 10.11 returns 204; newer versions return the created key. Reading by a unique
    // setup-attempt name supports both, without guessing or accidentally adopting another key.
    const result = await this.request(baseUrl, 'GET', 'Auth/Keys', { accessToken: adminToken });
    if (!isObject(result) || !Array.isArray(result.Items)) throw invalidResponse();
    // Jellyfin's API-key DTO leaves IsActive at its default false, even for usable keys.
    // Identify our key by its exact unique name; DateRevoked still rules out revoked keys.
    const matches = result.Items.filter(
      (item: unknown) =>
        isObject(item) &&
        item.AppName === appName &&
        (item.DateRevoked === undefined || item.DateRevoked === null),
    );
    if (matches.length !== 1 || !isObject(matches[0]) || !token(matches[0].AccessToken))
      throw new JellyfinAuthError(
        'Unable to identify the Jellyport API key created by this setup.',
        502,
      );
    return matches[0].AccessToken;
  }

  async deleteApiKey(baseUrl: string, adminToken: string, apiKey: string): Promise<void> {
    if (!token(apiKey)) throw new JellyfinAuthError('The Jellyport API key is invalid.', 400);
    await this.request(baseUrl, 'DELETE', `Auth/Keys/${encodeURIComponent(apiKey)}`, {
      accessToken: adminToken,
      decode: false,
    });
  }
}
