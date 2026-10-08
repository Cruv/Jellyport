import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Service } from './service.js';
import { BotManager } from './bot.js';
import { DemoServers } from './demo.js';
import { ServiceError, MediaError } from './errors.js';
import { DEMO_SETTINGS } from './types.js';
import { SECRET_FIELDS, validateSettings } from './settings.js';
import {
  hostPolicy,
  localSetupHost,
  privateAddress,
  sameOrigin,
  WindowLimiter,
} from './security.js';
import type { ClientFactory, MediaUser } from './media.js';
import {
  JellyfinAuthClient,
  JellyfinAuthError,
  normalizeJellyfinUrl,
  type JellyfinAuthentication,
  type JellyfinIdentity,
} from './jellyfin-auth.js';

const hashPassword = promisify(scrypt);
const COOKIE = 'jellyport_session';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
interface Session {
  address: string;
  authenticated: boolean;
  csrf_token: string;
  expires: number;
  identity?: JellyfinIdentity;
  connection?: { identity: JellyfinIdentity; serverUrl: string; generation: string };
}
interface AccountRequest {
  username: string;
  discord_user_id?: string | null;
}
interface RecoveryRequest extends AccountRequest {
  target_user_id: string;
}
interface MigrationRequest {
  source_user_ids: string[];
  discord_recipients?: Record<string, string>;
}
export interface CreateAppOptions {
  demoPassword?: string;
  dataDir?: string;
  demo?: boolean;
  secureCookie?: boolean;
  clientFactory?: ClientFactory;
  staticDir?: string;
  authClient?: JellyfinAuthentication;
  allowedHosts?: string[];
}
export type JellyportApp = FastifyInstance & {
  jellyport: { store: Store; service: Service; bot: BotManager };
};

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const id = { type: 'string', minLength: 1, maxLength: 128 };
const discordId = { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9]{5,22}$' }] };
const accountFields = {
  username: { type: 'string', minLength: 1, maxLength: 64 },
  discord_user_id: discordId,
};
const accountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['username'],
  properties: accountFields,
};
const migrationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source_user_ids'],
  properties: {
    source_user_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: id },
    discord_recipients: {
      type: 'object',
      maxProperties: 100,
      additionalProperties: { type: 'string', pattern: '^[0-9]{5,22}$' },
    },
  },
};

export async function createApp(options: CreateAppOptions = {}): Promise<JellyportApp> {
  const demo = options.demo ?? process.env.JELLYPORT_DEMO === 'true';
  const demoPassword = options.demoPassword ?? 'demo-jellyport';
  const secureCookie = options.secureCookie ?? process.env.JELLYPORT_SECURE_COOKIE === 'true';
  const allowedHost = hostPolicy(
    options.allowedHosts ??
      (process.env.JELLYPORT_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
  );
  const store = new Store(options.dataDir ?? process.env.JELLYPORT_DATA_DIR ?? './data', { demo });
  const authClient = options.authClient ?? new JellyfinAuthClient();
  if (!demo) store.ensureAuthState();
  const salt = randomBytes(16);
  const passwordHash = demo ? ((await hashPassword(demoPassword, salt, 64)) as Buffer) : null;
  let clientFactory = options.clientFactory;
  if (demo) {
    const servers = new DemoServers();
    store.saveSettings(structuredClone(DEMO_SETTINGS));
    clientFactory = servers.factory;
  }
  const service = new Service(store, { demo, clientFactory });
  const bot = new BotManager(service);
  service.bot = bot;
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    trustProxy: false,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 100,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  }) as unknown as JellyportApp;
  app.server.headersTimeout = 15_000;
  app.decorate('jellyport', { store, service, bot });
  const sessions = new Map<string, Session>();
  const anonymousSessions = new Map<string, Session>();
  const authenticatedSessions = new Map<string, Session>();
  const addresses = new Map<string, Set<string>>();
  const attempts = new WindowLimiter(10);
  const allocations = new WindowLimiter(60);
  await app.register(cookie);

  function removeSession(sid: string): Session | undefined {
    const value = sessions.get(sid);
    if (!value) return undefined;
    sessions.delete(sid);
    authenticatedSessions.delete(sid);
    anonymousSessions.delete(sid);
    const owned = addresses.get(value.address);
    owned?.delete(sid);
    if (owned?.size === 0) addresses.delete(value.address);
    return value;
  }
  function forget(request: FastifyRequest): Session | undefined {
    const sid = request.cookies[COOKIE] ?? '';
    return removeSession(sid);
  }
  async function revoke(value?: Session): Promise<void> {
    if (demo || !value) return;
    const identity = value.identity ?? value.connection?.identity;
    const state = store.authState();
    const url =
      value.connection?.serverUrl ?? (state?.kind === 'configured' ? state.serverUrl : '');
    if (identity && url) await authClient.signOut(url, identity.accessToken).catch(() => {});
  }
  function session(request: FastifyRequest): Session | undefined {
    const sid = request.cookies[COOKIE];
    const value = sid ? sessions.get(sid) : undefined;
    if (value && value.expires <= Date.now()) {
      removeSession(sid!);
      void revoke(value);
      return undefined;
    }
    return value;
  }
  function sessionView(value: Session) {
    const state = demo ? null : store.authState();
    return {
      authenticated: value.authenticated,
      csrf_token: value.csrf_token,
      demo,
      setup_required: !demo && state?.kind !== 'configured',
      setup_connected:
        !!value.connection &&
        state?.kind === 'pending' &&
        value.connection.generation === state.generation,
      ...(state?.kind === 'pending' && state.serverUrl
        ? { setup_server_url: normalizeJellyfinUrl(state.serverUrl) }
        : {}),
      ...(value.authenticated
        ? {
            user: {
              id: value.identity?.userId ?? 'demo-admin',
              name: value.identity?.username ?? 'admin',
            },
          }
        : {}),
    };
  }
  function csrf(request: FastifyRequest): void {
    const value = session(request);
    const token = request.headers['x-csrf-token'];
    if (!value || typeof token !== 'string' || !equal(value.csrf_token, token))
      throw Object.assign(new Error('Session expired or CSRF token missing. Reload the page.'), {
        statusCode: 403,
      });
  }
  function newSession(
    request: FastifyRequest,
    reply: FastifyReply,
    attributes: Partial<Session> = {},
  ) {
    if (!attributes.authenticated) {
      for (const sid of addresses.get(request.ip) ?? []) {
        const value = sessions.get(sid);
        if (value && value.expires <= Date.now()) void revoke(removeSession(sid));
      }
      const full = (addresses.get(request.ip)?.size ?? 0) >= 30;
      if (full || !allocations.allow(request.ip)) {
        reply.header('Retry-After', full ? '1800' : '600');
        throw Object.assign(
          new Error('Too many new sessions. Reuse your browser session or try again later.'),
          { statusCode: 429 },
        );
      }
    }
    // Anonymous visitors cannot consume the separate administrator session capacity.
    const pool = attributes.authenticated ? authenticatedSessions : anonymousSessions;
    if (pool.size >= (attributes.authenticated ? 1000 : 2000))
      void revoke(removeSession(pool.keys().next().value!));
    const sid = randomBytes(32).toString('base64url');
    const age = attributes.authenticated ? 28800 : 1800;
    const value: Session = {
      address: request.ip,
      authenticated: false,
      csrf_token: randomBytes(32).toString('base64url'),
      expires: Date.now() + age * 1000,
      ...attributes,
    };
    sessions.set(sid, value);
    pool.set(sid, value);
    if (!value.authenticated) {
      const owned = addresses.get(request.ip) ?? new Set<string>();
      owned.add(sid);
      addresses.set(request.ip, owned);
    }
    reply.setCookie(COOKIE, sid, {
      path: '/',
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      maxAge: age,
    });
    return sessionView(value);
  }
  function rateLimit(request: FastifyRequest) {
    if (!attempts.allow(request.ip))
      throw Object.assign(new Error('Too many sign-in attempts. Wait ten minutes.'), {
        statusCode: 429,
      });
  }
  async function authorize(request: FastifyRequest): Promise<Session> {
    const value = session(request);
    if (!value?.authenticated) throw new JellyfinAuthError('Sign in to Jellyport.', 401);
    if (demo) return value;
    const state = store.authState();
    if (state?.kind !== 'configured' || !value.identity) {
      forget(request);
      throw new JellyfinAuthError('Sign in to Jellyport.', 401);
    }
    try {
      const validated = await authClient.validateSession(
        state.serverUrl,
        value.identity.accessToken,
        state.serverId,
        value.identity.userId,
      );
      const current = store.authState();
      if (
        session(request) !== value ||
        current?.kind !== 'configured' ||
        current.serverId !== state.serverId ||
        current.serverUrl !== state.serverUrl
      )
        throw new JellyfinAuthError(
          'Your Jellyfin administrator session ended. Sign in again.',
          401,
        );
      value.identity = validated;
    } catch (error) {
      if (error instanceof JellyfinAuthError && [401, 403].includes(error.statusCode)) {
        forget(request);
        await revoke(value);
        throw new JellyfinAuthError(
          'Your Jellyfin administrator session ended. Sign in again.',
          401,
        );
      }
      throw error;
    }
    return value;
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    const host = request.headers.host ?? '';
    if (!allowedHost(host))
      throw new JellyfinAuthError(
        'This hostname is not allowed. Configure JELLYPORT_ALLOWED_HOSTS for your reverse proxy hostname.',
        403,
      );
    // Use the matched route so encoded aliases receive identical authorization.
    const path = request.routeOptions.url ?? '';
    if (!path.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (
      (origin !== undefined && !sameOrigin(host, origin)) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new JellyfinAuthError('Cross-site requests are not allowed.', 403);
    if (
      !demo &&
      store.authState()?.kind === 'pending' &&
      (path === '/api/session' || path.startsWith('/api/setup')) &&
      (!privateAddress(request.ip) || !localSetupHost(host))
    )
      throw new JellyfinAuthError(
        'Complete first-time setup through a trusted local network address or localhost.',
        403,
      );
    if (path === '/api/session' && request.method === 'GET') return;
    if (
      ['/api/login', '/api/logout', '/api/setup/connect', '/api/setup/complete'].includes(path) &&
      request.method === 'POST'
    ) {
      csrf(request);
      return;
    }
    if (path === '/api/setup' && request.method === 'GET') return;
    await authorize(request);
    if (!['GET', 'HEAD'].includes(request.method)) csrf(request);
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof JellyfinAuthError)
      return reply.code(error.statusCode).send({ detail: error.message });
    if (error instanceof ServiceError) return reply.code(400).send({ detail: error.message });
    if (error instanceof MediaError) return reply.code(502).send({ detail: error.message });
    if (error.validation)
      return reply
        .code(422)
        .send({ detail: 'Invalid request. Check the selected users and field values.' });
    const code = error.statusCode ?? 500;
    const detail =
      [401, 403, 429, 503].includes(code) && !error.code
        ? error.message
        : code === 413
          ? 'Request too large.'
          : code >= 400 && code < 500
            ? 'Invalid request. Check the selected users and field values.'
            : 'Request failed unexpectedly. Check configuration and server availability.';
    return reply.code(code >= 400 && code < 600 ? code : 500).send({ detail });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ detail: 'Not found.' }));
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/session', async (request, reply) => {
    const value = session(request);
    if (value?.authenticated) {
      try {
        await authorize(request);
      } catch (error) {
        if (!(error instanceof JellyfinAuthError) || error.statusCode !== 401) throw error;
      }
    }
    const current = session(request);
    return current ? sessionView(current) : newSession(request, reply);
  });
  const credentialsSchema = {
    username: { type: 'string', minLength: 1, maxLength: 256 },
    password: { type: 'string', minLength: 1, maxLength: 512 },
  };
  app.post<{ Body: { username: string; password: string } }>(
    '/api/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: credentialsSchema,
        },
      },
    },
    async (request, reply) => {
      rateLimit(request);
      const originalSession = session(request);
      if (!originalSession) throw new JellyfinAuthError('Session ended. Reload the page.', 401);
      let identity: JellyfinIdentity | undefined;
      if (demo) {
        const supplied = (await hashPassword(request.body.password, salt, 64)) as Buffer;
        if (request.body.username !== 'admin' || !timingSafeEqual(passwordHash!, supplied))
          throw new JellyfinAuthError('Incorrect demo username or password.', 401);
      } else {
        const state = store.authState();
        if (state?.kind !== 'configured')
          throw new JellyfinAuthError('Complete first-time setup before signing in.', 403);
        identity = await authClient.authenticate(
          state.serverUrl,
          request.body.username,
          request.body.password,
          state.serverId,
        );
        const current = store.authState();
        if (
          session(request) !== originalSession ||
          current?.kind !== 'configured' ||
          current.serverId !== state.serverId ||
          current.serverUrl !== state.serverUrl
        ) {
          await authClient.signOut(state.serverUrl, identity.accessToken).catch(() => {});
          throw new JellyfinAuthError('Server configuration changed. Reload the page.', 403);
        }
      }
      if (session(request) !== originalSession)
        throw new JellyfinAuthError('Session ended. Reload the page.', 401);
      void revoke(forget(request));
      attempts.delete(request.ip);
      return newSession(request, reply, { authenticated: true, identity });
    },
  );
  app.post('/api/logout', async (request, reply) => {
    const value = forget(request);
    reply.clearCookie(COOKIE, {
      path: '/',
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
    });
    await revoke(value);
    return newSession(request, reply);
  });
  function pendingConnection(request: FastifyRequest) {
    const value = session(request)?.connection;
    const state = store.authState();
    if (!value || state?.kind !== 'pending' || state.generation !== value.generation)
      throw new JellyfinAuthError('Connect Jellyfin in the setup wizard first.', 403);
    return value;
  }
  async function setupView(request: FastifyRequest) {
    const connection = pendingConnection(request);
    await authClient.validateSession(
      connection.serverUrl,
      connection.identity.accessToken,
      connection.identity.serverId,
      connection.identity.userId,
    );
    const client = service.clientFactory(
      connection.serverUrl,
      connection.identity.accessToken,
      'jellyfin',
    );
    let templates: MediaUser[];
    try {
      templates = (await client.users())
        .filter(
          (user) => user.Policy?.IsAdministrator === false && user.Policy?.IsDisabled === false,
        )
        .map((user) => ({ Id: user.Id, Name: user.Name }));
    } finally {
      await client.close();
    }
    if (pendingConnection(request) !== connection)
      throw new JellyfinAuthError('Setup session ended. Reload the page.', 403);
    const settings = store.settings();
    return {
      session: sessionView(session(request)!),
      server: { url: connection.serverUrl },
      templates,
      defaults: {
        template_user_id: settings.template_user_id,
        jellyfin_public_url: settings.jellyfin_public_url,
      },
    };
  }
  app.get('/api/setup', async (request) => setupView(request));
  app.post<{
    Body: { jellyfin_url: string; username: string; password: string };
  }>(
    '/api/setup/connect',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['jellyfin_url', 'username', 'password'],
          properties: {
            ...credentialsSchema,
            jellyfin_url: { type: 'string', minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      rateLimit(request);
      const originalSession = session(request);
      if (!originalSession) throw new JellyfinAuthError('Session ended. Reload the page.', 401);
      const state = store.authState();
      if (demo || state?.kind !== 'pending')
        throw new JellyfinAuthError('Jellyport is already configured.', 403);
      const serverUrl = normalizeJellyfinUrl(request.body.jellyfin_url);
      if (state.serverUrl && serverUrl !== normalizeJellyfinUrl(state.serverUrl))
        throw new JellyfinAuthError(
          'Complete setup using the Jellyfin server already linked to this installation.',
          403,
        );
      const identity = await authClient.authenticate(
        serverUrl,
        request.body.username,
        request.body.password,
        state.previousServerId,
      );
      try {
        const client = service.clientFactory(serverUrl, identity.accessToken, 'jellyfin');
        let templates: MediaUser[];
        try {
          templates = (await client.users())
            .filter(
              (user) => user.Policy?.IsAdministrator === false && user.Policy?.IsDisabled === false,
            )
            .map((user) => ({ Id: user.Id, Name: user.Name }));
        } finally {
          await client.close();
        }
        const current = store.authState();
        if (
          session(request) !== originalSession ||
          current?.kind !== 'pending' ||
          current.generation !== state.generation
        )
          throw new JellyfinAuthError(
            'Setup was completed in another session. Reload the page.',
            403,
          );
        void revoke(forget(request));
        const view = newSession(request, reply, {
          connection: { identity, serverUrl, generation: state.generation },
        });
        const settings = store.settings();
        attempts.delete(request.ip);
        return {
          session: view,
          server: { url: serverUrl },
          templates,
          defaults: {
            template_user_id: settings.template_user_id,
            jellyfin_public_url: settings.jellyfin_public_url,
          },
        };
      } catch (error) {
        await authClient.signOut(serverUrl, identity.accessToken).catch(() => {});
        throw error;
      }
    },
  );
  app.post<{ Body: { template_user_id: string; jellyfin_public_url: string } }>(
    '/api/setup/complete',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['template_user_id', 'jellyfin_public_url'],
          properties: {
            template_user_id: id,
            jellyfin_public_url: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const connection = pendingConnection(request);
      await authClient.validateSession(
        connection.serverUrl,
        connection.identity.accessToken,
        connection.identity.serverId,
        connection.identity.userId,
      );
      const settings = {
        ...store.settings(),
        jellyfin_url: connection.serverUrl,
        template_user_id: request.body.template_user_id,
        jellyfin_public_url: request.body.jellyfin_public_url,
      };
      validateSettings(settings);
      const client = service.clientFactory(
        connection.serverUrl,
        connection.identity.accessToken,
        'jellyfin',
      );
      try {
        const template = await client.user(request.body.template_user_id);
        if (template.Policy?.IsAdministrator !== false || template.Policy?.IsDisabled !== false)
          throw new ServiceError('Choose an enabled, non-administrator Jellyfin template user.');
      } finally {
        await client.close();
      }
      const apiKeyName = `Jellyport ${randomUUID()}`;
      const key = await authClient.createApiKey(
        connection.serverUrl,
        connection.identity.accessToken,
        apiKeyName,
      );
      try {
        if (pendingConnection(request) !== connection)
          throw new JellyfinAuthError('Setup session ended. Reload the page.', 403);
        const claimed = store.completeAuth(
          connection.generation,
          {
            kind: 'configured',
            serverUrl: connection.serverUrl,
            serverId: connection.identity.serverId,
            apiKeyName,
          },
          (current) => ({
            ...current,
            jellyfin_url: connection.serverUrl,
            jellyfin_api_key: key,
            template_user_id: request.body.template_user_id,
            jellyfin_public_url: request.body.jellyfin_public_url.replace(/\/+$/, ''),
          }),
        );
        if (!claimed)
          throw new JellyfinAuthError(
            'Setup was completed in another session. Reload the page.',
            403,
          );
      } catch (error) {
        await authClient
          .deleteApiKey(connection.serverUrl, connection.identity.accessToken, key)
          .catch(() => {});
        throw error;
      }
      forget(request); // Transfer the interactive token to the newly rotated authenticated cookie.
      const result = newSession(request, reply, {
        authenticated: true,
        identity: connection.identity,
      });
      await service.start();
      await bot.restart(store.settings());
      return result;
    },
  );
  function publicSettings() {
    const settings = store.settings();
    const result: Record<string, unknown> = { ...settings };
    for (const key of SECRET_FIELDS) {
      delete result[key];
      result[`${key}_set`] = Boolean(settings[key]);
    }
    result.jellyfin_auth_managed = !demo && store.authState()?.kind === 'configured';
    result.bot_invite_url = settings.discord_application_id
      ? `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: settings.discord_application_id, scope: 'bot applications.commands', permissions: '68608', guild_id: settings.discord_guild_id, disable_guild_select: 'true' })}`
      : '';
    return result;
  }
  app.get('/api/settings', async () => publicSettings());
  app.put<{ Body: Record<string, unknown> }>(
    '/api/settings',
    { schema: { body: { type: 'object' } } },
    async (request) => {
      if (demo)
        throw new ServiceError(
          'Demo settings are read-only. Run without JELLYPORT_DEMO to connect your servers.',
        );
      const incoming = { ...request.body };
      for (const key of SECRET_FIELDS) if (incoming[key] === '') delete incoming[key];
      const binding = store.authState();
      if (binding?.kind === 'configured') {
        if (
          incoming.jellyfin_url !== undefined &&
          (typeof incoming.jellyfin_url !== 'string' ||
            normalizeJellyfinUrl(incoming.jellyfin_url) !== binding.serverUrl)
        )
          throw new ServiceError(
            'Jellyfin is managed by administrator sign-in. Use a separate data directory to link another server.',
          );
        if (incoming.jellyfin_api_key !== undefined)
          throw new ServiceError(
            'Use Refresh Jellyfin service key to replace the managed API key.',
          );
        delete incoming.jellyfin_url;
      }
      const settings = { ...store.settings(), ...incoming };
      validateSettings(settings);
      for (const key of ['emby_url', 'jellyfin_url', 'jellyfin_public_url'] as const)
        settings[key] = settings[key].replace(/\/+$/, '');
      store.saveSettings(settings);
      await bot.restart(settings);
      return publicSettings();
    },
  );
  let refreshingKey = false;
  app.post('/api/auth/service-key', async (request) => {
    if (demo) throw new ServiceError('Demo settings are read-only.');
    if (refreshingKey) throw new ServiceError('A service key refresh is already in progress.');
    const state = store.authState();
    const originalSession = session(request);
    const identity = originalSession?.identity;
    if (state?.kind !== 'configured' || !identity)
      throw new JellyfinAuthError('Sign in to Jellyport.', 401);
    refreshingKey = true;
    try {
      const apiKeyName = `Jellyport ${randomUUID()}`;
      const key = await authClient.createApiKey(state.serverUrl, identity.accessToken, apiKeyName);
      try {
        if (session(request) !== originalSession)
          throw new JellyfinAuthError('Session ended. Sign in again.', 401);
        if (!store.updateServiceKey(state.serverId, key, apiKeyName))
          throw new JellyfinAuthError('Server configuration changed. Reload the page.', 403);
      } catch (error) {
        await authClient.deleteApiKey(state.serverUrl, identity.accessToken, key).catch(() => {});
        throw error;
      }
      return publicSettings();
    } finally {
      refreshingKey = false;
    }
  });
  app.get('/api/users', async () => {
    const users = await service.users();
    // Only the fields used by the interface cross the browser boundary. Upstream user
    // DTOs can contain private configuration and new fields added by server plugins.
    const summary = (user: MediaUser) => ({
      Id: user.Id,
      Name: user.Name,
      Policy: {
        ...(typeof user.Policy?.IsAdministrator === 'boolean'
          ? { IsAdministrator: user.Policy.IsAdministrator }
          : {}),
        ...(typeof user.Policy?.IsDisabled === 'boolean'
          ? { IsDisabled: user.Policy.IsDisabled }
          : {}),
      },
    });
    return {
      emby: users.emby.map(summary),
      jellyfin: users.jellyfin.map(summary),
      errors: users.errors,
    };
  });
  app.post('/api/connections/test', async () => service.connections());
  app.get('/api/overview', async () => {
    const connections = await service.connections();
    const users = await service.users();
    const jobs = store.jobs();
    return {
      counts: {
        emby_users: users.emby.length,
        jellyfin_users: users.jellyfin.length,
        jobs: jobs.length,
      },
      connections,
      recent_jobs: jobs.slice(0, 6),
      pending_subscriptions: store.subscriptions().filter((event) => event.status === 'pending')
        .length,
      demo,
    };
  });
  app.post<{ Body: MigrationRequest }>(
    '/api/migrations/preview',
    { schema: { body: migrationSchema } },
    async (request) => service.preview(request.body.source_user_ids),
  );
  app.post<{ Body: MigrationRequest }>(
    '/api/migrations',
    { schema: { body: migrationSchema } },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.migrateUsers(request.body.source_user_ids, request.body.discord_recipients),
        ),
  );
  app.post<{ Body: AccountRequest }>(
    '/api/accounts',
    { schema: { body: accountSchema } },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.createAccount(
            request.body.username,
            request.body.discord_user_id ?? undefined,
          ),
        ),
  );
  app.get<{ Querystring: { username: string } }>(
    '/api/accounts/recovery',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['username'],
          properties: { username: accountFields.username },
        },
      },
    },
    async (request) => service.recoveryInfo(request.query.username),
  );
  app.post<{ Body: RecoveryRequest }>(
    '/api/accounts/recover',
    {
      schema: {
        body: {
          ...accountSchema,
          required: ['username', 'target_user_id'],
          properties: { ...accountFields, target_user_id: id },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.recoverAccount(
            request.body.username,
            request.body.target_user_id,
            request.body.discord_user_id ?? undefined,
          ),
        ),
  );
  app.get('/api/jobs', async () => ({ jobs: store.jobs() }));
  app.get<{ Params: { job_id: string } }>('/api/jobs/:job_id', async (request) =>
    service.getJob(request.params.job_id),
  );
  app.post<{ Params: { job_id: string } }>('/api/jobs/:job_id/credentials', async (request) => {
    const job = service.getJob(request.params.job_id);
    if (['queued', 'running'].includes(job.status))
      throw new ServiceError('Wait for the job to finish before revealing its credentials.');
    return { credentials: store.takeCredentials(job.id) };
  });
  app.get('/api/subscriptions', async () => ({ events: store.subscriptions() }));
  app.post<{ Params: { event_id: string } }>(
    '/api/subscriptions/:event_id/apply',
    async (request) => service.applySubscription(request.params.event_id),
  );
  app.post<{ Params: { event_id: string } }>(
    '/api/subscriptions/:event_id/ignore',
    async (request) => service.ignoreSubscription(request.params.event_id),
  );
  const staticDir = resolve(options.staticDir ?? 'dist/client');
  if (existsSync(resolve(staticDir, 'index.html'))) {
    await app.register(staticFiles, { root: staticDir, index: false });
    app.get('/', (_request, reply) => reply.sendFile('index.html'));
  } else {
    app.get('/', (_request, reply) =>
      reply.code(503).send({
        detail:
          'Build the React interface with npm run build, or use npm run dev:ui during development.',
      }),
    );
  }
  let upkeep: Promise<void> | null = null;
  const maintenance = setInterval(() => {
    if (upkeep) return;
    upkeep = (async () => {
      store.purgeExpired();
      for (const [sid, value] of sessions)
        if (value.expires <= Date.now()) {
          removeSession(sid);
          await revoke(value);
        }
      if (!demo && store.authState()?.kind === 'configured') await service.reconcileMemberships();
    })()
      .catch(() => {})
      .finally(() => {
        upkeep = null;
      });
  }, 300000);
  maintenance.unref();
  app.addHook('onClose', async () => {
    clearInterval(maintenance);
    await Promise.all([bot.stop(), service.stop()]);
    await upkeep;
    await Promise.all([...sessions.values()].map((value) => revoke(value)));
    sessions.clear();
    anonymousSessions.clear();
    authenticatedSessions.clear();
    addresses.clear();
    allocations.clear();
    store.close();
    attempts.clear();
  });
  try {
    if (!demo && store.authState()?.kind === 'configured') await bot.restart(store.settings());
    if (demo || store.authState()?.kind === 'configured') await service.start();
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
