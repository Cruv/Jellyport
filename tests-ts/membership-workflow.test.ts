import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoServers } from '../server/demo.js';
import { Service, type BotAdapter, type MembershipWorkflowInput } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import { ServiceError } from '../server/errors.js';

const owner = '123456789012345678';
const otherOwner = '223456789012345678';
const writeMethods = new Set([
  'createUser',
  'setPassword',
  'setPolicy',
  'setConfiguration',
  'setDisplayPreferences',
  'markPlayed',
  'markFavorite',
  'updateUserData',
  'createPlaylist',
  'addPlaylistItems',
  'setUserImage',
]);

describe('read-only membership workflow and reviewed ownership reuse', () => {
  let folder: string, store: Store, servers: DemoServers, service: Service;
  let calls: Array<{ kind: string; method: string }>;
  let onRead: ((kind: string, method: string) => Promise<void> | void) | undefined;
  let schedule: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'jellyport-membership-workflow-'));
    store = new Store(folder);
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      template_user_id: 'template',
      discord_enabled: true,
      discord_guild_id: '323456789012345678',
    });
    servers = new DemoServers();
    for (const user of servers.users.emby)
      user.Policy = { IsAdministrator: false, IsDisabled: false };
    calls = [];
    onRead = undefined;
    service = new Service(store, {
      clientFactory: (...args) => {
        const client = servers.factory(...args),
          kind = args[2] ?? 'jellyfin';
        return new Proxy(client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return async (...parameters: unknown[]) => {
              calls.push({ kind, method: String(property) });
              if (!writeMethods.has(String(property))) await onRead?.(kind, String(property));
              return Reflect.apply(value, target, parameters);
            };
          },
        });
      },
    });
    service.bot = {
      status: () => ({ connected: true }),
      recipientIdentity: vi.fn(async (id) => ({ id, username: 'crew_owner' })),
      validateRecipient: vi.fn(async () => {}),
      sendCredentials: vi.fn(async () => {}),
      membershipActive: async () => true,
      activeMembers: async () => [],
    } satisfies BotAdapter;
    schedule = vi
      .spyOn(service as unknown as { schedule: (...args: unknown[]) => void }, 'schedule')
      .mockImplementation(() => {});
  });
  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  });
  function draft(patch: Partial<MembershipWorkflowInput> = {}): MembershipWorkflowInput {
    return {
      discord_user_id: owner,
      access_mode: 'subscription',
      tier_id: 'sloop',
      provision_jellyfin: true,
      ...patch,
    };
  }
  function savedMember(patch: Record<string, unknown> = {}) {
    return service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'crew_owner',
        tier_id: 'sloop',
        account_limit: 1,
        access_mode: 'subscription',
        provision_jellyfin: true,
        ...patch,
      },
      store.settings(),
    );
  }
  function approve(kind: 'emby' | 'jellyfin', accountId: string, slot = 1, discordId = owner) {
    const user = servers.users[kind].find((item) => item.Id === accountId)!;
    service.mediaOwnerships.save(
      [
        {
          kind,
          server_id: `demo-${kind}`,
          account_id: accountId,
          username: user.Name,
          discord_user_id: discordId,
          slot,
        },
      ],
      store.settings(),
    );
  }
  function noWrites() {
    expect(calls.filter((call) => writeMethods.has(call.method))).toEqual([]);
    expect(
      calls.every((call) => ['users', 'user', 'systemInfo', 'close'].includes(call.method)),
    ).toBe(true);
  }
  it('reviews an already confirmed differently named Jellyfin account without requiring a mapping or saving any relationship', async () => {
    approve('jellyfin', 'j-river');
    const member = savedMember();
    const before = JSON.stringify({
      members: service.listMemberships(),
      owners: service.mediaOwnerships.list(store.settings()),
    });
    const reviewed = await service.reviewMembershipWorkflow(
      draft({ expected_revision: member.revision }),
    );
    expect(reviewed.summary).toMatchObject({
      policy_only: false,
      account_limit: 1,
      accounts: [{ slot: 1, username: 'river', action: 'manage', target_user_id: 'j-river' }],
    });
    expect(
      JSON.stringify({
        members: service.listMemberships(),
        owners: service.mediaOwnerships.list(store.settings()),
      }),
    ).toBe(before);
    expect(store.links()).toEqual([]);
    expect(service.mappings.list(store.settings())).toEqual([]);
    expect(store.jobs()).toEqual([]);
    expect(schedule).not.toHaveBeenCalled();
    noWrites();
    const result = await service.applyMembershipWorkflow(reviewed);
    expect(result.job?.kind).toBe('membership');
    expect(store.link(owner)).toMatchObject({
      remote_id: 'j-river',
      username: 'river',
      membership_slot: 1,
    });
    const queued = store.queuedJobs()[0]!;
    expect(queued.requests).toMatchObject([
      {
        target_user_id: 'j-river',
        username: 'river',
        access_disabled: false,
        membership_revision: result.membership.revision,
      },
    ]);
    expect(service.mappings.list(store.settings())).toEqual([]);
    noWrites();
  });

  it('reuses a confirmed Emby source with an arbitrary alias and pins that source in durable queued work', async () => {
    approve('emby', 'e-alex');
    const reviewed = await service.reviewMembershipWorkflow(draft());
    expect(reviewed.summary.accounts).toMatchObject([
      { username: 'alex', slot: 1, action: 'migrate', source_user_id: 'e-alex' },
    ]);
    expect(store.jobs()).toEqual([]);
    noWrites();
    const result = await service.applyMembershipWorkflow(reviewed);
    expect(result.job).not.toBeNull();
    expect(store.queuedJobs()[0]!.requests[0]).toMatchObject({
      source_user_id: 'e-alex',
      username: 'alex',
      source_ownership: { server_id: 'demo-emby' },
      membership_revision: result.membership.revision,
    });
    noWrites();
  });

  it('saves an Emby-only opt-out as a policy without creating or requiring a Jellyfin account', async () => {
    approve('emby', 'e-alex');
    const reviewed = await service.reviewMembershipWorkflow(draft({ provision_jellyfin: false }));
    expect(reviewed.summary).toMatchObject({
      policy_only: true,
      provision_jellyfin: false,
      accounts: [],
    });
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(calls).toEqual([]);
    const result = await service.applyMembershipWorkflow(reviewed);
    expect(result.job).toBeNull();
    expect(result.membership).toMatchObject({ provision_jellyfin: false, account_limit: 1 });
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(servers.users.jellyfin.map((user) => user.Name)).not.toContain('alex');
    noWrites();
  });

  it('preserves an inactive paid membership and enrollment hold during a policy-only change', async () => {
    const member = savedMember({
      active: false,
      inactive_reason: 'cancel',
      new_subscriber_pending: true,
      provision_jellyfin: false,
    });
    const input = draft({
      tier_id: 'brigantine',
      account_limit: 2,
      provision_jellyfin: false,
      expected_revision: member.revision,
    });
    const review = await service.reviewMembershipWorkflow(input);
    expect(review.summary.policy_only).toBe(true);
    expect(review.summary.warnings.join(' ')).toContain('remains inactive');
    const result = await service.applyMembershipWorkflow(review);
    expect(result.job).toBeNull();
    expect(result.membership).toMatchObject({
      active: false,
      inactive_reason: 'cancel',
      new_subscriber_pending: true,
      account_limit: 2,
      provision_jellyfin: false,
    });
    expect(store.jobs()).toEqual([]);
    noWrites();
  });

  it('allows an existing policy-only edit when Discord is unavailable without clearing inactive access or an enrollment hold', async () => {
    const member = savedMember({
      active: false,
      inactive_reason: 'expire',
      new_subscriber_pending: true,
      provision_jellyfin: false,
    });
    service.bot = null;
    const review = await service.reviewMembershipWorkflow(
      draft({ provision_jellyfin: false, expected_revision: member.revision }),
    );
    expect(review.summary.policy_only).toBe(true);
    const result = await service.applyMembershipWorkflow(review);
    expect(result.job).toBeNull();
    expect(result.membership).toMatchObject({
      active: false,
      inactive_reason: 'expire',
      new_subscriber_pending: true,
      provision_jellyfin: false,
    });
    expect(calls).toEqual([]);
    expect(store.jobs()).toEqual([]);
  });

  it('rejects inactive paid provisioning during read-only review before it can clear a hold or change accounts', async () => {
    const member = savedMember({
      active: false,
      inactive_reason: 'expire',
      new_subscriber_pending: true,
    });
    await expect(
      service.reviewMembershipWorkflow(draft({ expected_revision: member.revision })),
    ).rejects.toThrow(/inactive/);
    expect(service.memberships.get(owner, store.settings())).toEqual(member);
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    noWrites();
  });

  it('allows an explicit complimentary draft for a roleless owner and reports Family preservation before acceptance', async () => {
    const existing = savedMember({ active: false, inactive_reason: 'cancel' });
    approve('jellyfin', 'j-river');
    service.profiles.save(
      {
        kind: 'jellyfin',
        user_id: 'j-river',
        family: true,
        owner_name: 'Synthetic family',
        notes: '',
      },
      store.settings(),
    );
    service.bot!.validateRecipient = vi.fn(async () => {
      throw new ServiceError('No paid role');
    });
    const reviewed = await service.reviewMembershipWorkflow(
      draft({
        access_mode: 'complimentary',
        tier_id: 'complimentary',
        account_limit: 1,
        expected_revision: existing.revision,
      }),
    );
    expect(reviewed.summary.accounts[0]?.action).toBe('family_preserved');
    expect(service.bot!.validateRecipient).not.toHaveBeenCalled();
    expect(service.memberships.get(owner, store.settings())).toEqual(existing);
    const result = await service.applyMembershipWorkflow(reviewed);
    expect(result.membership).toMatchObject({ access_mode: 'complimentary', active: true });
    expect(service.profiles.get('jellyfin', 'j-river', store.settings())?.family).toBe(true);
    noWrites();
  });

  it.each(['renamed_target', 'owner', 'profile', 'membership', 'settings'])(
    'rejects a %s change after review without partial policy, lifecycle links or queued work',
    async (change) => {
      approve('jellyfin', 'j-river');
      const member = savedMember();
      const reviewed = await service.reviewMembershipWorkflow(
        draft({ expected_revision: member.revision }),
      );
      if (change === 'renamed_target') servers.users.jellyfin[1]!.Name = 'renamed';
      if (change === 'owner') approve('jellyfin', 'j-river', 1, otherOwner);
      if (change === 'profile')
        service.profiles.save(
          { kind: 'jellyfin', user_id: 'j-river', family: true, owner_name: '', notes: '' },
          store.settings(),
        );
      if (change === 'membership') savedMember({ account_limit: 2, tier_id: 'brigantine' });
      if (change === 'settings')
        store.saveSettings({ ...store.settings(), template_user_id: 'changed-template' });
      const before = service.memberships.get(owner, store.settings());
      await expect(service.applyMembershipWorkflow(reviewed)).rejects.toThrow();
      expect(service.memberships.get(owner, store.settings())).toEqual(before);
      expect(store.jobs()).toEqual([]);
      expect(store.links()).toEqual([]);
      noWrites();
    },
  );

  it('rolls back the new membership and adopted lifecycle link if durable queue persistence fails', async () => {
    approve('jellyfin', 'j-river');
    const reviewed = await service.reviewMembershipWorkflow(draft());
    store.db.exec(
      `CREATE TRIGGER reject_membership_workflow_queue BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'synthetic queue failure'); END;`,
    );
    await expect(service.applyMembershipWorkflow(reviewed)).rejects.toThrow(
      'synthetic queue failure',
    );
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    expect(store.links()).toEqual([]);
    expect(store.jobs()).toEqual([]);
    noWrites();
  });

  it('stops an expired session immediately after an awaited target read before any later read or mutation', async () => {
    approve('jellyfin', 'j-river');
    let authorized = true;
    onRead = (kind, method) => {
      if (kind === 'jellyfin' && method === 'systemInfo') authorized = false;
    };
    await expect(
      service.reviewMembershipWorkflow(draft(), () => {
        if (!authorized) throw new ServiceError('Synthetic session ended');
      }),
    ).rejects.toThrow('Synthetic session ended');
    expect(calls.filter((call) => call.kind === 'jellyfin').map((call) => call.method)).toEqual([
      'systemInfo',
      'close',
    ]);
    expect(store.jobs()).toEqual([]);
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    noWrites();
  });

  it('keeps an approved account that was manually disabled disabled during the real queued access update', async () => {
    approve('jellyfin', 'j-river');
    servers.users.jellyfin[1]!.Policy!.IsDisabled = true;
    const reviewed = await service.reviewMembershipWorkflow(draft());
    expect(reviewed.summary.warnings.join(' ')).toContain('disabled manually');
    noWrites();
    schedule.mockRestore();
    const result = await service.applyMembershipWorkflow(reviewed);
    await service.jobTasks.get(result.job!.id);
    expect(servers.users.jellyfin[1]!.Policy!.IsDisabled).toBe(true);
    expect(calls.filter((call) => writeMethods.has(call.method))).toEqual([]);
    expect(service.bot!.sendCredentials).not.toHaveBeenCalled();
    expect(service.getJob(result.job!.id).results[0]?.created).toBe(false);
  });

  it('executes a confirmed alias migration without an extra mapping or borrowing another account history', async () => {
    approve('emby', 'e-alex');
    const review = await service.reviewMembershipWorkflow(draft());
    noWrites();
    schedule.mockRestore();
    const result = await service.applyMembershipWorkflow(review);
    await service.jobTasks.get(result.job!.id);
    const outcome = service.getJob(result.job!.id);
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]).toMatchObject({
      username: 'alex',
      source_username: 'alex',
      created: true,
    });
    const link = store.link(owner)!;
    expect(link.username).toBe('alex');
    expect(
      service.mediaOwnerships
        .list(store.settings())
        .find((item) => item.kind === 'jellyfin' && item.account_id === link.remote_id),
    ).toMatchObject({ discord_user_id: owner, slot: 1, username: 'alex' });
    expect(service.mappings.list(store.settings())).toEqual([]);
    expect(servers.played['j-river']).toEqual(new Set(['1']));
  });

  it('reviews a downgrade of confirmed alias slots and preserves a manually flagged Family extra', async () => {
    savedMember({ tier_id: 'brigantine', account_limit: 2 });
    servers.users.jellyfin.push({
      Id: 'j-cabin',
      Name: 'cabin_alias',
      Policy: { IsAdministrator: false, IsDisabled: false },
    });
    approve('jellyfin', 'j-river', 1);
    approve('jellyfin', 'j-cabin', 2);
    service.profiles.save(
      { kind: 'jellyfin', user_id: 'j-cabin', family: true, owner_name: '', notes: '' },
      store.settings(),
    );
    const review = await service.reviewMembershipWorkflow(draft({ provision_jellyfin: false }));
    expect(review.summary.accounts.map(({ username, action }) => ({ username, action }))).toEqual([
      { username: 'river', action: 'manage' },
      { username: 'cabin_alias', action: 'family_preserved' },
    ]);
    noWrites();
    schedule.mockRestore();
    const result = await service.applyMembershipWorkflow(review);
    await service.jobTasks.get(result.job!.id);
    expect(result.membership.account_limit).toBe(1);
    expect(servers.users.jellyfin.find((item) => item.Id === 'j-cabin')?.Policy?.IsDisabled).toBe(
      false,
    );
    expect(service.profiles.get('jellyfin', 'j-cabin', store.settings())?.family).toBe(true);
    expect(calls.filter((call) => writeMethods.has(call.method))).toEqual([]);
  });

  it.each(['server', 'protected', 'duplicate_slot'])(
    'rejects a confirmed target with a %s conflict during preflight without creating lifecycle authority',
    async (problem) => {
      approve('jellyfin', 'j-river');
      if (problem === 'server') {
        const original = service.clientFactory;
        service.clientFactory = (...args) => {
          const client = original(...args);
          if (args[2] === 'jellyfin')
            client.systemInfo = async () => ({ Id: 'replacement-jellyfin' });
          return client;
        };
      }
      if (problem === 'protected') servers.users.jellyfin[1]!.Policy!.IsAdministrator = true;
      if (problem === 'duplicate_slot') {
        servers.users.jellyfin.push({
          Id: 'j-other',
          Name: 'another_alias',
          Policy: { IsAdministrator: false, IsDisabled: false },
        });
        approve('jellyfin', 'j-other');
      }
      await expect(service.reviewMembershipWorkflow(draft())).rejects.toThrow();
      expect(service.memberships.get(owner, store.settings())).toBeNull();
      expect(store.links()).toEqual([]);
      expect(store.jobs()).toEqual([]);
      noWrites();
    },
  );

  it('uses confirmed ownership for the existing provisionMembership path too', async () => {
    approve('jellyfin', 'j-river');
    const job = await service.provisionMembership(owner, 'sloop');
    expect(job.kind).toBe('membership');
    expect(store.link(owner)?.remote_id).toBe('j-river');
    expect(store.queuedJobs()[0]?.requests[0]).toMatchObject({
      username: 'river',
      target_user_id: 'j-river',
      access_disabled: false,
    });
    noWrites();
  });
  it('checks standalone creation defaults and identity before any final queue or media write', async () => {
    const result = await service.reviewAccountCreation({ username: 'new_local_user' });
    expect(result).toEqual({ username: 'new_local_user', ready: true });
    expect(store.jobs()).toEqual([]);
    expect(store.links()).toEqual([]);
    expect(service.memberships.get(owner, store.settings())).toBeNull();
    noWrites();
  });

  it('reports a missing creation default during read-only preflight', async () => {
    store.saveSettings({ ...store.settings(), template_user_id: '', default_role_id: '' });
    await expect(service.reviewAccountCreation({ username: 'new_local_user' })).rejects.toThrow(
      /default account role|template user/,
    );
    expect(store.jobs()).toEqual([]);
    noWrites();
  });

  it.each(['wrong_username', 'inactive', 'held', 'confirmed_target', 'confirmed_source'])(
    'identifies the %s creation prerequisite before final confirmation without requiring manual remapping',
    async (problem) => {
      if (problem === 'inactive') savedMember({ active: false, inactive_reason: 'cancel' });
      if (problem === 'held') savedMember({ new_subscriber_pending: true });
      if (problem === 'confirmed_target') approve('jellyfin', 'j-river');
      if (problem === 'confirmed_source') approve('emby', 'e-alex');
      await expect(
        service.reviewAccountCreation({
          username: problem === 'wrong_username' ? 'server_nickname' : 'crew_owner',
          discord_user_id: owner,
        }),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
      expect(store.jobs()).toEqual([]);
      expect(store.links()).toEqual([]);
      noWrites();
    },
  );

  it.each(['river', 'RIVER'])(
    'rejects an existing Jellyfin username %s in creation preflight without adopting or changing it',
    async (username) => {
      await expect(service.reviewAccountCreation({ username })).rejects.toThrow(
        /already exists|letter case/,
      );
      expect(store.jobs()).toEqual([]);
      expect(servers.users.jellyfin[1]?.Name).toBe('river');
      noWrites();
    },
  );

  it('stops creation preflight after an expired session without continuing to account names or defaults', async () => {
    let authorized = true;
    onRead = (kind, method) => {
      if (kind === 'jellyfin' && method === 'systemInfo') authorized = false;
    };
    await expect(
      service.reviewAccountCreation({ username: 'new_local_user' }, () => {
        if (!authorized) throw new ServiceError('Synthetic session ended');
      }),
    ).rejects.toThrow('Synthetic session ended');
    expect(calls.map((call) => call.method)).toEqual(['systemInfo', 'close']);
    expect(store.jobs()).toEqual([]);
    noWrites();
  });
  it('rejects a membership that becomes inactive while creation prerequisites are being read', async () => {
    savedMember();
    onRead = (kind, method) => {
      if (kind === 'jellyfin' && method === 'systemInfo')
        savedMember({ active: false, inactive_reason: 'cancel' });
    };
    await expect(
      service.reviewAccountCreation({ username: 'crew_owner', discord_user_id: owner }),
    ).rejects.toThrow('membership changed');
    expect(calls.map((call) => call.method)).toEqual(['systemInfo', 'close']);
    expect(store.jobs()).toEqual([]);
    noWrites();
  });
  it.each(['emby', 'jellyfin'] as const)(
    'rechecks confirmed %s ownership at final creation admission after an earlier ready preflight',
    async (kind) => {
      await expect(
        service.reviewAccountCreation({ username: 'crew_owner', discord_user_id: owner }),
      ).resolves.toMatchObject({ ready: true });
      approve(kind, kind === 'emby' ? 'e-alex' : 'j-river');
      calls.length = 0;
      await expect(service.createAccount('crew_owner', owner)).rejects.toThrow(/confirmed/);
      expect(store.jobs()).toEqual([]);
      expect(calls).toEqual([]);
      noWrites();
    },
  );

  it('rechecks a newly added enrollment hold at final creation admission', async () => {
    await service.reviewAccountCreation({ username: 'crew_owner', discord_user_id: owner });
    savedMember({ new_subscriber_pending: true });
    calls.length = 0;
    await expect(service.createAccount('crew_owner', owner)).rejects.toThrow('enrollment hold');
    expect(service.memberships.get(owner, store.settings())?.new_subscriber_pending).toBe(true);
    expect(store.jobs()).toEqual([]);
    expect(calls).toEqual([]);
    noWrites();
  });

  it('rejects missing defaults at final creation admission after an earlier ready preflight', async () => {
    await service.reviewAccountCreation({ username: 'new_local_user' });
    store.saveSettings({ ...store.settings(), template_user_id: '', default_role_id: '' });
    await expect(service.createAccount('new_local_user')).rejects.toThrow(
      /default account role|template user/,
    );
    expect(store.jobs()).toEqual([]);
    noWrites();
  });

  it('rejects a session lost during final creation admission before later reads or queue persistence', async () => {
    await service.reviewAccountCreation({ username: 'new_local_user' });
    let authorized = true;
    calls.length = 0;
    onRead = (kind, method) => {
      if (kind === 'jellyfin' && method === 'systemInfo') authorized = false;
    };
    await expect(
      service.createAccount('new_local_user', null, () => {
        if (!authorized) throw new ServiceError('Synthetic session ended');
      }),
    ).rejects.toThrow('Synthetic session ended');
    expect(calls.map((call) => call.method)).toEqual(['systemInfo', 'close']);
    expect(store.jobs()).toEqual([]);
    noWrites();
  });

  it('checks ownership that appears while final creation metadata is in flight', async () => {
    let added = false;
    onRead = (kind, method) => {
      if (!added && kind === 'jellyfin' && method === 'systemInfo') {
        added = true;
        approve('emby', 'e-alex');
      }
    };
    await expect(service.createAccount('crew_owner', owner)).rejects.toThrow('confirmed Emby');
    expect(calls.map((call) => call.method)).toEqual(['systemInfo', 'close']);
    expect(store.jobs()).toEqual([]);
    noWrites();
  });

  it.each(['legacy_link', 'confirmed_ownership'])(
    'keeps an active enrollment hold when an existing account-only update reuses %s with provisioning off',
    async (source) => {
      const member = savedMember({ active: true, new_subscriber_pending: true });
      if (source === 'legacy_link') store.saveLink(owner, 'river', 'j-river');
      else approve('jellyfin', 'j-river');
      const reviewed = await service.reviewMembershipWorkflow(
        draft({ provision_jellyfin: false, expected_revision: member.revision }),
      );
      expect(reviewed.summary.policy_only).toBe(false);
      expect(reviewed.summary.warnings.join(' ')).toContain('enrollment hold remains');
      const result = await service.applyMembershipWorkflow(reviewed);
      expect(result.membership).toMatchObject({
        active: true,
        new_subscriber_pending: true,
        provision_jellyfin: false,
      });
      expect(result.job?.kind).toBe('membership');
      expect(
        store.queuedJobs()[0]?.requests.every((request) => request.access_disabled !== undefined),
      ).toBe(true);
      noWrites();
    },
  );

  it('preserves an active enrollment hold when the direct policy editor explicitly saves provisioning off', async () => {
    const member = savedMember({ active: true, new_subscriber_pending: true });
    const changed = await service.setMembershipAccess({
      discord_user_id: owner,
      access_mode: 'subscription',
      tier_id: 'sloop',
      provision_jellyfin: false,
      expected_revision: member.revision,
    });
    expect(changed).toMatchObject({
      active: true,
      new_subscriber_pending: true,
      provision_jellyfin: false,
    });
    expect(store.jobs()).toEqual([]);
    noWrites();
  });
});
