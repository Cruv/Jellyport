import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Service } from './service.js';
import { BotManager } from './bot.js';
import { DemoServers } from './demo.js';
import { ServiceError, MediaError } from './errors.js';
import { DEFAULT_SETTINGS } from './types.js';
import { SECRET_FIELDS, validateSettings } from './settings.js';
import type { ClientFactory } from './media.js';

const hashPassword = promisify(scrypt);
const COOKIE = 'jellyport_session';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
interface Session {
  authenticated: boolean;
  csrf_token: string;
  expires: number;
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
  adminPassword?: string;
  dataDir?: string;
  demo?: boolean;
  secureCookie?: boolean;
  clientFactory?: ClientFactory;
  staticDir?: string;
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
  const password =
    options.adminPassword ?? process.env.JELLYPORT_ADMIN_PASSWORD ?? (demo ? 'demo-jellyport' : '');
  if (password.length < 12 || password.length > 512 || password.startsWith('replace-with'))
    throw new Error(
      'Set JELLYPORT_ADMIN_PASSWORD to a strong password of 12–512 characters before starting Jellyport.',
    );
  const secureCookie = options.secureCookie ?? process.env.JELLYPORT_SECURE_COOKIE === 'true';
  const salt = randomBytes(16);
  const passwordHash = (await hashPassword(password, salt, 64)) as Buffer;
  const store = new Store(options.dataDir ?? process.env.JELLYPORT_DATA_DIR ?? './data');
  let clientFactory = options.clientFactory;
  if (demo) {
    const servers = new DemoServers();
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://demo-emby',
      emby_api_key: 'demo',
      jellyfin_url: 'http://demo-jellyfin',
      jellyfin_api_key: 'demo',
      jellyfin_public_url: 'https://jellyfin.example.com',
      template_user_id: 'template',
    });
    clientFactory = servers.factory;
  }
  const service = new Service(store, { demo, clientFactory });
  const bot = new BotManager(service);
  service.bot = bot;
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    trustProxy: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  }) as unknown as JellyportApp;
  app.decorate('jellyport', { store, service, bot });
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, number[]>();
  await app.register(cookie);

  function session(request: FastifyRequest): Session | undefined {
    const sid = request.cookies[COOKIE];
    const value = sid ? sessions.get(sid) : undefined;
    if (value && value.expires <= Date.now()) {
      sessions.delete(sid!);
      return undefined;
    }
    return value;
  }
  function csrf(request: FastifyRequest): void {
    const value = session(request);
    const token = request.headers['x-csrf-token'];
    if (!value || typeof token !== 'string' || !equal(value.csrf_token, token))
      throw Object.assign(new Error('Session expired or CSRF token missing. Reload the page.'), {
        statusCode: 403,
      });
  }
  function newSession(reply: FastifyReply, authenticated = false) {
    for (const [sid, value] of sessions) if (value.expires <= Date.now()) sessions.delete(sid);
    if (sessions.size >= 10000)
      throw Object.assign(new Error('Too many active sessions. Try again later.'), {
        statusCode: 503,
      });
    const sid = randomBytes(32).toString('base64url');
    const age = authenticated ? 28800 : 1800;
    const value = {
      authenticated,
      csrf_token: randomBytes(32).toString('base64url'),
      expires: Date.now() + age * 1000,
    };
    sessions.set(sid, value);
    reply.setCookie(COOKIE, sid, {
      path: '/',
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      maxAge: age,
    });
    return { authenticated, csrf_token: value.csrf_token, demo };
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    // Authenticate the matched route, not the raw URL. The router decodes static
    // path segments, so checking request.url would miss aliases such as /%61pi/.
    const path = request.routeOptions.url ?? '';
    if (!path.startsWith('/api/')) return;
    if (path === '/api/session' && request.method === 'GET') return;
    if (path === '/api/login' && request.method === 'POST') {
      csrf(request);
      return;
    }
    if (!session(request)?.authenticated)
      throw Object.assign(new Error('Sign in to Jellyport.'), { statusCode: 401 });
    if (!['GET', 'HEAD'].includes(request.method)) csrf(request);
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof ServiceError) return reply.code(400).send({ detail: error.message });
    if (error instanceof MediaError) return reply.code(502).send({ detail: error.message });
    if (error.validation)
      return reply
        .code(422)
        .send({ detail: 'Invalid request. Check the selected users and field values.' });
    const code = error.statusCode ?? 500;
    const allowed = [401, 403, 429, 503];
    const detail =
      allowed.includes(code) && !error.code
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
    return value
      ? { authenticated: value.authenticated, csrf_token: value.csrf_token, demo }
      : newSession(reply);
  });
  app.post<{ Body: { password: string } }>(
    '/api/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['password'],
          properties: { password: { type: 'string', maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      const now = Date.now();
      const recent = (attempts.get(request.ip) ?? []).filter((time) => time > now - 600000);
      if (recent.length >= 10)
        throw Object.assign(new Error('Too many sign-in attempts. Wait ten minutes.'), {
          statusCode: 429,
        });
      recent.push(now);
      attempts.set(request.ip, recent);
      const supplied = (await hashPassword(request.body.password, salt, 64)) as Buffer;
      if (!timingSafeEqual(passwordHash, supplied))
        throw Object.assign(new Error('Incorrect admin password.'), { statusCode: 401 });
      attempts.delete(request.ip);
      sessions.delete(request.cookies[COOKIE] ?? '');
      return newSession(reply, true);
    },
  );
  app.post('/api/logout', async (request, reply) => {
    sessions.delete(request.cookies[COOKIE] ?? '');
    return newSession(reply);
  });
  function publicSettings() {
    const settings = store.settings();
    const result: Record<string, unknown> = { ...settings };
    for (const key of SECRET_FIELDS) {
      delete result[key];
      result[`${key}_set`] = Boolean(settings[key]);
    }
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
      const settings = { ...store.settings(), ...incoming };
      validateSettings(settings);
      for (const key of ['emby_url', 'jellyfin_url', 'jellyfin_public_url'] as const)
        settings[key] = settings[key].replace(/\/+$/, '');
      store.saveSettings(settings);
      await bot.restart(settings);
      return publicSettings();
    },
  );
  app.get('/api/users', async () => service.users());
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
      reply
        .code(503)
        .send({
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
      if (!demo) await service.reconcileMemberships();
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
    store.close();
    sessions.clear();
    attempts.clear();
  });
  try {
    if (!demo) await bot.restart(store.settings());
    await service.start();
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
