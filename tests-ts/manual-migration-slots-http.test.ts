import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type JellyportApp } from '../server/main.js';
import { DemoServers } from '../server/demo.js';

const owner = '123456789012345678';
const ids = ['e-harbor', 'e-cabin'];
const resources: Array<{ app: JellyportApp; directory: string }> = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-manual-slot-http-'));
  const servers = new DemoServers();
  servers.users.emby = ids.map((Id, index) => ({
    Id,
    Name: index ? 'Cabin' : 'Harbor',
    Policy: { IsAdministrator: false, IsDisabled: false },
  }));
  servers.users.jellyfin = servers.users.jellyfin.filter((user) => user.Id === 'template');
  const identity = {
    serverId: 'demo-jellyfin',
    userId: 'admin',
    username: 'admin',
    accessToken: 'synthetic-session',
  };
  const app = await createApp({
    dataDir: directory,
    clientFactory: servers.factory,
    authClient: {
      authenticate: async () => identity,
      validateSession: async () => identity,
      signOut: async () => {},
      validateApiKey: async () => ({ serverId: identity.serverId, apiKeyName: 'synthetic' }),
    },
  });
  resources.push({ app, directory });
  const { store, service } = app.jellyport;
  const pending = store.authState();
  if (pending?.kind !== 'pending') throw new Error('Expected synthetic fresh setup');
  store.completeAuth(
    pending.generation,
    {
      kind: 'configured',
      serverId: identity.serverId,
      serverUrl: 'http://jellyfin.example.test',
      apiKeyName: 'synthetic',
    },
    (settings) => ({
      ...settings,
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-source',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-destination',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '223456789012345678',
    }),
  );
  service.bot = {
    status: () => ({ connected: true }),
    recipientIdentity: vi.fn(async (id) => ({ id, username: 'crew_owner' })),
    validateRecipient: vi.fn(async () => {}),
    sendCredentials: vi.fn(async () => {}),
    membershipActive: async () => true,
    activeMembers: async () => [],
  };
  service.memberships.save(
    {
      discord_user_id: owner,
      base_username: 'crew_owner',
      tier_id: 'brigantine',
      account_limit: 2,
      active: true,
      access_mode: 'complimentary',
      provision_jellyfin: true,
    },
    store.settings(),
  );
  async function login() {
    const anonymous = await app.inject('/api/session');
    const signed = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        cookie: `jellyport_session=${anonymous.cookies[0]!.value}`,
        'x-csrf-token': anonymous.json().csrf_token,
      },
      payload: { username: 'admin', password: 'synthetic-password' },
    });
    expect(signed.statusCode).toBe(200);
    return {
      cookie: `jellyport_session=${signed.cookies[0]!.value}`,
      'x-csrf-token': signed.json().csrf_token as string,
    };
  }
  const headers = await login();
  async function review(sourceUserIds = ids) {
    const start = await app.inject({
      method: 'POST',
      url: '/api/migrations/preview',
      headers,
      payload: { source_user_ids: sourceUserIds },
    });
    expect(start.statusCode).toBe(202);
    const id = start.json().id;
    let value: any;
    await vi.waitFor(async () => {
      const response = await app.inject({ url: `/api/migrations/preview/${id}`, headers });
      value = response.json();
      expect(value.status).toBe('ready');
    });
    return value;
  }
  const payload = (preview_id?: string) => ({
    ...(preview_id ? { preview_id } : {}),
    source_user_ids: ids,
    discord_recipients: Object.fromEntries(ids.map((id) => [id, owner])),
    membership_slots: { [ids[0]!]: 1, [ids[1]!]: 2 },
  });
  return { app, store, service, servers, headers, login, review, payload };
}

describe('reviewed manual migration account slots', () => {
  it('takes custom-name source identity only from the signed-in administrator’s ready review', async () => {
    const f = await fixture();
    const review = await f.review();
    const migrate = vi.spyOn(f.service, 'migrateUsers').mockResolvedValue({
      id: 'synthetic-slot-job',
      kind: 'migrate',
      status: 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      progress: { processed: 0, total: 2 },
      results: [],
    });
    // Editing the received JSON cannot replace the server's captured identity.
    review.preview.owner_assignment_sources[ids[0]!].source_username = 'client-forged';
    const accepted = await f.app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers: f.headers,
      payload: f.payload(review.id),
    });
    expect(accepted.statusCode).toBe(202);
    expect(migrate).toHaveBeenCalledExactlyOnceWith(
      ids,
      Object.fromEntries(ids.map((id) => [id, owner])),
      { [ids[0]!]: null, [ids[1]!]: null },
      'watched_only',
      undefined,
      expect.objectContaining({ preview_id: review.id }),
      undefined,
      undefined,
      {
        [ids[0]!]: {
          server_id: 'demo-emby',
          source_username: 'Harbor',
          discord_user_id: owner,
          slot: 1,
        },
        [ids[1]!]: {
          server_id: 'demo-emby',
          source_username: 'Cabin',
          discord_user_id: owner,
          slot: 2,
        },
      },
      expect.any(Function),
    );
  });

  it('rejects missing, foreign, canceled and forged reviews or invalid slot selections without queueing', async () => {
    const f = await fixture();
    const review = await f.review();
    const other = await f.login();
    const migrate = vi.spyOn(f.service, 'migrateUsers');
    const cases = [
      [f.headers, f.payload(), 400],
      [other, f.payload(review.id), 400],
      [f.headers, { ...f.payload(review.id), membership_slots: { unknown: 2 } }, 400],
      [f.headers, { ...f.payload(review.id), discord_recipients: {} }, 400],
      [f.headers, { ...f.payload(review.id), membership_slots: { [ids[0]!]: 0 } }, 422],
      [f.headers, { ...f.payload(review.id), membership_slots: { [ids[0]!]: 4 } }, 422],
      [f.headers, { ...f.payload(review.id), membership_slots: { [ids[0]!]: '2' } }, 422],
      [f.headers, { ...f.payload(review.id), owner_assignment_sources: {} }, 422],
    ] as const;
    for (const [headers, payload, status] of cases)
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/migrations', headers, payload }))
          .statusCode,
      ).toBe(status);
    await f.app.inject({
      method: 'DELETE',
      url: `/api/migrations/preview/${review.id}`,
      headers: f.headers,
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/migrations',
          headers: f.headers,
          payload: f.payload(review.id),
        })
      ).statusCode,
    ).toBe(400);
    expect(migrate).not.toHaveBeenCalled();
    expect(f.store.jobs()).toEqual([]);
    expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
  });

  it.each(['cancel', 'logout'] as const)(
    'withdraws manual ownership approval after %s during recipient verification',
    async (action) => {
      const f = await fixture();
      const review = await f.review();
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recipient = vi
        .mocked(f.service.bot!.recipientIdentity)
        .mockImplementation(async (id) => {
          await waiting;
          return { id, username: 'crew_owner' };
        });
      const pending = f.app
        .inject({
          method: 'POST',
          url: '/api/migrations',
          headers: f.headers,
          payload: f.payload(review.id),
        })
        .then((response) => response);
      await vi.waitFor(() => expect(recipient).toHaveBeenCalled());
      if (action === 'cancel')
        await f.app.inject({
          method: 'DELETE',
          url: `/api/migrations/preview/${review.id}`,
          headers: f.headers,
        });
      else await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers });
      release();
      expect((await pending).statusCode).toBe(action === 'logout' ? 401 : 400);
      expect(f.store.jobs()).toEqual([]);
      expect(f.store.links()).toEqual([]);
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual([]);
      expect(f.servers.users.jellyfin.map((user) => user.Name)).toEqual(['Member template']);
      expect(f.service.bot!.sendCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(['cancel', 'logout'] as const)(
    'does not adopt an ownerless mapping after %s interrupts its approved source owner check',
    async (action) => {
      const f = await fixture();
      const mapping = f.service.mappings.save(
        {
          source_user_id: ids[0]!,
          source_username: 'Harbor',
          target_user_id: null,
          target_username: 'HarborAlias',
          discord_user_id: null,
          discord_username: null,
        },
        f.store.settings(),
      );
      f.service.mediaOwnerships.save(
        [
          {
            kind: 'emby',
            server_id: 'demo-emby',
            account_id: ids[0]!,
            username: 'Harbor',
            discord_user_id: owner,
            slot: 1,
          },
        ],
        f.store.settings(),
      );
      const originalOwnership = f.service.mediaOwnerships.list(f.store.settings());
      const review = await f.review([ids[0]!]);
      expect(review.preview.users[0].owner_basis).toBe('approved');
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recipient = vi
        .mocked(f.service.bot!.recipientIdentity)
        .mockImplementation(async (id) => {
          await waiting;
          return { id, username: 'crew_owner' };
        });
      recipient.mockClear();
      const pending = f.app
        .inject({
          method: 'POST',
          url: '/api/migrations',
          headers: f.headers,
          payload: {
            preview_id: review.id,
            source_user_ids: [ids[0]!],
            discord_recipients: { [ids[0]!]: owner },
          },
        })
        .then((response) => response);
      await vi.waitFor(() => expect(recipient).toHaveBeenCalled());
      if (action === 'cancel')
        await f.app.inject({
          method: 'DELETE',
          url: `/api/migrations/preview/${review.id}`,
          headers: f.headers,
        });
      else await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers });
      release();
      expect((await pending).statusCode).toBe(action === 'logout' ? 401 : 400);
      expect(f.service.mappings.get(mapping.id, f.store.settings())).toEqual(mapping);
      expect(f.service.mediaOwnerships.list(f.store.settings())).toEqual(originalOwnership);
      expect(f.store.jobs()).toEqual([]);
      expect(f.store.links()).toEqual([]);
      expect(f.servers.users.jellyfin.map((user) => user.Name)).toEqual(['Member template']);
      expect(f.service.bot!.sendCredentials).not.toHaveBeenCalled();
    },
  );
});

describe('session-owned migration membership review', () => {
  async function linkedFixture() {
    const f = await fixture();
    f.store.db.exec('DELETE FROM memberships');
    f.store.saveSettings({ ...f.store.settings(), new_subscriber_source: 'stripe' });
    const lookup = vi.fn(async () => ({
      status: 'verified' as const,
      tier_id: 'galleon',
      tier_name: 'Galleon',
      account_limit: 3,
      message: 'Synthetic verified paid subscription',
      proof: {
        token: 'private-stripe-evidence',
        owner_id: owner,
        tier_id: 'galleon',
        tier_name: 'Galleon',
        account_limit: 3,
        observed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        paid_through: '2099-01-01T00:00:00.000Z',
        context: 'synthetic-context',
      },
    }));
    f.service.reviewStripeMigrationMembership = lookup;
    f.service.verifyStripeMigrationMembership = vi.fn();
    const review = await f.review();
    const resolve = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/migrations/preview/${review.id}/membership`,
        headers: f.headers,
        payload: { discord_user_id: owner },
      });
    return { ...f, lookup, review, resolve };
  }
  it('keeps proof private and enrolls the reviewed owner when migration is accepted', async () => {
    const f = await linkedFixture();
    const membership = await f.resolve();
    expect(membership.statusCode).toBe(200);
    expect(membership.headers['cache-control']).toBe('no-store');
    const body = membership.json();
    expect(body).toMatchObject({
      discord_user_id: owner,
      status: 'active',
      source: 'stripe',
      tier_name: 'Galleon',
      account_limit: 3,
      allowed_slots: [1, 2, 3],
      review_token: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private-stripe-evidence|stripe_proof|previous_revision|settings_hash/,
    );
    expect(
      JSON.stringify(
        (
          await f.app.inject({ url: `/api/migrations/preview/${f.review.id}`, headers: f.headers })
        ).json(),
      ),
    ).not.toContain(body.review_token);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
    expect(f.store.jobs()).toEqual([]);
    const accepted = await f.app.inject({
      method: 'POST',
      url: '/api/migrations',
      headers: f.headers,
      payload: {
        ...f.payload(f.review.id),
        membership_review_tokens: { [owner]: body.review_token },
      },
    });
    expect(accepted.statusCode).toBe(202);
    await f.service.jobTasks.get(accepted.json().id);
    expect(f.service.memberships.get(owner, f.store.settings())).toMatchObject({
      tier_id: 'galleon',
      account_limit: 3,
      provision_jellyfin: false,
    });
    expect(f.lookup).toHaveBeenCalledTimes(2);
  });
  it('rejects foreign sessions, forged tokens and changed owner IDs', async () => {
    const f = await linkedFixture();
    const body = (await f.resolve()).json();
    const other = await f.login();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/migrations/preview/${f.review.id}/membership`,
          headers: other,
          payload: { discord_user_id: owner },
        })
      ).statusCode,
    ).toBe(404);
    for (const tokens of [
      { [owner]: '00000000-0000-4000-8000-000000000000' },
      { '223456789012345678': body.review_token },
    ])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/migrations',
            headers: f.headers,
            payload: { ...f.payload(f.review.id), membership_review_tokens: tokens },
          })
        ).statusCode,
      ).toBe(400);
    expect(f.store.jobs()).toEqual([]);
    expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
  });
  it.each(['cancel', 'logout'] as const)(
    'discards a membership lookup after %s',
    async (action) => {
      const f = await linkedFixture();
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const response = await f.lookup();
      f.lookup.mockClear();
      f.lookup.mockImplementation(async () => {
        await wait;
        return response;
      });
      const pending = f.resolve().then((result) => result);
      await vi.waitFor(() => expect(f.lookup).toHaveBeenCalled());
      if (action === 'cancel')
        await f.app.inject({
          method: 'DELETE',
          url: `/api/migrations/preview/${f.review.id}`,
          headers: f.headers,
        });
      else await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers });
      release();
      expect((await pending).statusCode).toBe(action === 'logout' ? 401 : 404);
      expect(f.store.jobs()).toEqual([]);
      expect(f.service.memberships.get(owner, f.store.settings())).toBeNull();
      expect(f.service.bot!.sendCredentials).not.toHaveBeenCalled();
    },
  );
});
