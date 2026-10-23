import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Service, type Job } from '../server/service.js';
import { DemoServers } from '../server/demo.js';
import { discordCredentialContent } from '../server/credentials.js';
import type { BotMessageHistory } from '../server/bot-messages.js';
import { createApp, type JellyportApp } from '../server/main.js';

const directories: string[] = [],
  stores: Store[] = [],
  apps: JellyportApp[] = [];
const message = (fields: Partial<BotMessageHistory> = {}): BotMessageHistory => ({
  id: 'synthetic-delivery',
  kind: 'credentials',
  recipient_id: '100001',
  account_username: 'river_2',
  membership_slot: 2,
  content: 'Account river_2\nPassword: SYNTHETIC_PRIVATE_PASSWORD',
  status: 'pending',
  created_at: new Date().toISOString(),
  ...fields,
});
const job = (): Job => ({
  id: 'synthetic-job',
  kind: 'create',
  status: 'completed',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  progress: { processed: 1, total: 1 },
  results: [],
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-private-messages-'));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  store.saveJob(job());
  return { store, directory };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('private administrator bot message archive', () => {
  it('retains exact acknowledged content separately from consumed recovery credentials, encrypted on disk', () => {
    const { store, directory } = fixture(),
      pending = message();
    store.saveBotMessage(job().id, pending);
    const sent = {
      ...pending,
      status: 'sent' as const,
      message_id: '200001',
      sent_at: new Date().toISOString(),
    };
    store.saveBotMessage(job().id, sent);
    store.saveCredentials(
      job().id,
      'river_2',
      'SYNTHETIC_PRIVATE_PASSWORD',
      'https://media.example.test',
    );
    store.takeCredentials(job().id);
    expect(store.botMessages(job().id)).toEqual([sent]);
    store.saveJob({ ...job(), status: 'partial' });
    expect(store.botMessages(job().id)).toEqual([sent]);
    expect(() => store.saveBotMessage(job().id, { ...sent, content: 'rewritten' })).toThrow(
      'immutable',
    );
    for (const file of ['jellyport.db', 'jellyport.db-wal'])
      if (existsSync(join(directory, file)))
        expect(
          readFileSync(join(directory, file)).includes(Buffer.from('SYNTHETIC_PRIVATE_PASSWORD')),
        ).toBe(false);
    expect(JSON.stringify(store.jobs())).not.toContain('SYNTHETIC_PRIVATE_PASSWORD');
  });
  it('removes archived messages with their activity and expires only archive copies under their separate retention', () => {
    const { store } = fixture();
    store.saveBotMessage(
      job().id,
      message({ created_at: new Date(Date.now() - 2 * 86400_000).toISOString() }),
    );
    store.saveSettings({ ...store.settings(), bot_message_retention_days: 1 });
    expect(store.botMessages(job().id)).toEqual([]);
    store.pruneBotMessages();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM bot_message_history').get()?.count).toBe(
      0,
    );
    store.saveSettings({ ...store.settings(), bot_message_retention_days: 0 });
    store.saveBotMessage(
      job().id,
      message({ created_at: '2000-01-01T00:00:00.000Z', status: 'sent' }),
    );
    store.pruneBotMessages();
    expect(store.botMessages(job().id)).toHaveLength(1);
    expect(store.clearJobHistory([job().id], new Set()).removed_ids).toEqual([job().id]);
    expect(store.botMessages(job().id)).toEqual([]);
  });
  it('marks a pending send as uncertain after restart and never fabricates an acknowledgement', () => {
    const { store, directory } = fixture();
    store.saveBotMessage(job().id, message());
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(directory);
    stores.push(reopened);
    const recovered = reopened.botMessages(job().id)[0];
    expect(recovered).toMatchObject({ status: 'uncertain' });
    expect(recovered).not.toHaveProperty('message_id');
    expect(recovered).not.toHaveProperty('sent_at');
  });
  it('requires an authenticated administrator and exposes private messages only through the dedicated no-store endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-messages-api-'));
    directories.push(directory);
    const app = await createApp({
      demo: true,
      demoPassword: 'synthetic-password',
      dataDir: directory,
    });
    apps.push(app);
    app.jellyport.store.saveJob(job());
    app.jellyport.store.saveBotMessage(job().id, message({ status: 'sent' }));
    app.jellyport.store.saveSubscription({
      id: 'synthetic-billing-event',
      action: 'subscribe',
      status: 'pending',
      created_at: new Date().toISOString(),
      source: 'stripe',
      stripe_entitlement: {
        provider: 'stripe',
        event_id: 'synthetic-billing-event',
        action: 'subscribe',
        discord_user_id: '100001',
        customer_id: 'cus_PRIVATE_PROOF',
        subscription_id: 'sub_PRIVATE_PROOF',
        invoice_id: 'in_PRIVATE_PROOF',
        tier_id: 'sloop',
        price_id: 'price_PRIVATE_PROOF',
        created_at: new Date().toISOString(),
        paid_through: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        activation_revision: 'synthetic',
        generation: 'synthetic',
        is_new: false,
        authority_revision: 'synthetic',
      },
    });
    expect((await app.inject('/api/jobs/synthetic-job/messages')).statusCode).toBe(401);
    const anonymous = await app.inject('/api/session');
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `${anonymous.cookies[0].name}=${anonymous.cookies[0].value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'admin', password: 'synthetic-password' },
    });
    expect(login.statusCode).toBe(200);
    const headers = { cookie: `${login.cookies[0].name}=${login.cookies[0].value}` };
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ url: '/api/jobs/synthetic-job/messages', headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.json().messages[0].content).toContain('SYNTHETIC_PRIVATE_PASSWORD');
    }
    for (const url of ['/api/jobs', '/api/jobs/synthetic-job'])
      expect((await app.inject({ url, headers })).body).not.toContain('SYNTHETIC_PRIVATE_PASSWORD');
    const billing = await app.inject({ url: '/api/subscriptions', headers });
    expect(billing.statusCode).toBe(200);
    expect(billing.json().events[0].id).toBe('synthetic-billing-event');
    expect(billing.body).not.toContain('PRIVATE_PROOF');
    expect(billing.body).not.toContain('stripe_entitlement');
  });
  it.each(['cleanup', 'archive'] as const)(
    'keeps acknowledged Discord delivery distinct from a post-send %s storage failure',
    async (failure) => {
      const { store } = fixture();
      const servers = new DemoServers();
      store.saveSettings({
        ...store.settings(),
        jellyfin_url: 'https://media.example.test',
        jellyfin_api_key: 'synthetic-key',
        template_user_id: 'template',
        discord_enabled: true,
      });
      const service = new Service(store, { clientFactory: servers.factory });
      service.bot = {
        status: () => ({ connected: true }),
        recipientIdentity: async (id) => ({ id, username: 'fresh_owner' }),
        validateRecipient: async () => {},
        membershipActive: async () => true,
        activeMembers: async () => [],
        sendCredentials: async (_id, _username, _password, _url, _required, content) => ({
          content: discordCredentialContent(content!),
          message_id: '200001',
        }),
      };
      if (failure === 'cleanup')
        vi.spyOn(store, 'deleteCredentials').mockImplementation(() => {
          throw new Error('synthetic storage unavailable');
        });
      else {
        const original = store.saveBotMessage.bind(store);
        vi.spyOn(store, 'saveBotMessage').mockImplementation((id, value) => {
          if (value.status === 'sent') throw new Error('synthetic archive unavailable');
          original(id, value);
        });
      }
      try {
        const queued = await service.createAccount('fresh_owner', '100001');
        await service.jobTasks.get(queued.id);
        const result = service.getJob(queued.id).results[0];
        expect(result.error).toBeUndefined();
        expect(result).toMatchObject({ discord_delivery: 'sent' });
        expect(result.delivery_error).toContain('Discord confirmed delivery');
        expect(store.takeCredentials(queued.id)).toHaveLength(1);
        expect(store.botMessages(queued.id)[0].status).toBe(
          failure === 'cleanup' ? 'sent' : 'uncertain',
        );
      } finally {
        vi.restoreAllMocks();
        await service.stop();
      }
    },
  );
});
