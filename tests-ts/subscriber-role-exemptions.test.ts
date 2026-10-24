import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoServers } from '../server/demo.js';
import { Service } from '../server/service.js';
import { DEFAULT_SETTINGS, Store } from '../server/store.js';
import type { AccountProfileKind } from '../server/account-profiles.js';
import type { IdentityException } from '../server/identity-review-types.js';
import type { ClientFactory } from '../server/media.js';

const owner = '100001',
  otherOwner = '100002';

describe('subscriber role cleanup access exceptions', () => {
  let directory: string, store: Store, service: Service;
  let mediaFactory: Mock<ClientFactory>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jellyport-subscriber-exemptions-'));
    store = new Store(directory);
    store.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      emby_url: 'http://emby.example.test',
      emby_api_key: 'synthetic-emby-key',
      jellyfin_url: 'http://jellyfin.example.test',
      jellyfin_api_key: 'synthetic-jellyfin-key',
      discord_guild_id: '123456789012345678',
      new_subscriber_source: 'stripe',
    });
    const pending = store.ensureAuthState();
    if (pending.kind !== 'pending') throw new Error('Expected isolated setup');
    store.completeAuth(
      pending.generation,
      {
        kind: 'configured',
        serverUrl: store.settings().jellyfin_url,
        serverId: 'synthetic-jellyfin',
        apiKeyName: 'fixture',
      },
      (settings) => settings,
    );
    const servers = new DemoServers();
    mediaFactory = vi.fn(servers.factory);
    service = new Service(store, { clientFactory: mediaFactory });
  });

  afterEach(async () => {
    await service.stop();
    expect(mediaFactory).not.toHaveBeenCalled();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function membership(accessMode: 'subscription' | 'complimentary' = 'subscription') {
    return service.memberships.save(
      {
        discord_user_id: owner,
        base_username: 'member',
        tier_id: accessMode === 'subscription' ? 'galleon' : 'complimentary',
        account_limit: 3,
        access_mode: accessMode,
        provision_jellyfin: false,
        active: true,
      },
      store.settings(),
    );
  }

  function family(kind: AccountProfileKind, id: string, enabled = true) {
    return service.profiles.save(
      { kind, user_id: id, family: enabled, owner_name: '', notes: '' },
      store.settings(),
    );
  }

  function ownership(kind: AccountProfileKind, id: string, discordId = owner) {
    service.mediaOwnerships.save(
      [
        {
          kind,
          server_id: `synthetic-${kind}`,
          account_id: id,
          username: 'secondary.account',
          discord_user_id: discordId,
          slot: 3,
        },
      ],
      store.settings(),
    );
  }

  function mapping(discordId: string | null = owner, target: string | null = 'j-secondary') {
    return service.mappings.save(
      {
        source_user_id: 'e-secondary',
        source_username: 'legacy.secondary',
        target_user_id: target,
        target_username: 'secondary.account',
        discord_user_id: discordId,
        discord_username: discordId ? 'member' : null,
        membership_slot: 3,
      },
      store.settings(),
    );
  }

  it('allows ordinary linked paid owners and owners without a membership policy', () => {
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
    membership();
    store.saveLink(owner, 'member', 'j-primary');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
  });

  it('preserves whole-member complimentary access without requiring media accounts', () => {
    membership('complimentary');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
    expect(service.subscriberRoleCleanupExempt(otherOwner)).toBe(false);
  });

  it.each<IdentityException['kind']>(['non_media', 'complimentary', 'approved'])(
    'preserves an approved %s Discord access exception',
    (kind) => {
      membership();
      service.mediaOwnerships.annotate(
        `discord:${owner}`,
        {
          kind,
          note: 'Administrator approved this access.',
          approved_at: new Date().toISOString(),
        },
        store.settings(),
      );
      expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
      expect(service.subscriberRoleCleanupExempt(otherOwner)).toBe(false);
    },
  );

  it.each<AccountProfileKind>(['emby', 'jellyfin'])(
    'preserves the owner-wide subscriber role when any approved %s account is Family',
    (kind) => {
      membership();
      const id = `${kind}-secondary`;
      ownership(kind, id);
      family(kind, id);
      expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
      expect(service.subscriberRoleCleanupExempt(otherOwner)).toBe(false);
    },
  );

  it.each<AccountProfileKind>(['emby', 'jellyfin'])(
    'preserves the owner-wide subscriber role when a mapped %s account is Family',
    (kind) => {
      membership();
      mapping();
      family(kind, kind === 'emby' ? 'e-secondary' : 'j-secondary');
      expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
    },
  );

  it('preserves an Emby-only Family owner whose mapping has no destination account', () => {
    mapping(owner, null);
    family('emby', 'e-secondary');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
    expect(store.linksForMember(owner)).toEqual([]);
  });

  it('preserves an owner whose secondary lifecycle-linked Jellyfin account is Family', () => {
    membership();
    store.saveLink(owner, 'member', 'j-primary', false, 1);
    store.saveLink(owner, 'secondary.account', 'j-secondary', true, 3);
    family('jellyfin', 'j-secondary');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
  });

  it.each<{
    association: 'approved' | 'mapping' | 'lifecycle';
    kind: AccountProfileKind;
    id: string;
  }>([
    { association: 'approved', kind: 'emby', id: 'e-secondary' },
    { association: 'approved', kind: 'jellyfin', id: 'j-secondary' },
    { association: 'mapping', kind: 'emby', id: 'e-secondary' },
    { association: 'mapping', kind: 'jellyfin', id: 'j-secondary' },
    { association: 'lifecycle', kind: 'jellyfin', id: 'j-secondary' },
  ])(
    'preserves a prior standalone $kind exception after $association ownership is confirmed',
    ({ association, kind, id }) => {
      service.mediaOwnerships.annotate(
        `account:${kind}:${id}`,
        {
          kind: 'approved',
          note: 'Standalone account access was approved before linking.',
          approved_at: new Date().toISOString(),
        },
        store.settings(),
      );
      expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
      if (association === 'approved') ownership(kind, id);
      else if (association === 'mapping') mapping();
      else store.saveLink(owner, 'secondary.account', id, false, 3);
      expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
      expect(service.subscriberRoleCleanupExempt(otherOwner)).toBe(false);
    },
  );

  it('does not infer an account annotation exemption from an unowned mapping or another owner', () => {
    mapping(null);
    ownership('jellyfin', 'other-account', otherOwner);
    for (const id of ['e-secondary', 'other-account'])
      service.mediaOwnerships.annotate(
        `account:${id.startsWith('e-') ? 'emby' : 'jellyfin'}:${id}`,
        {
          kind: 'non_media',
          note: 'Separately approved access.',
          approved_at: new Date().toISOString(),
        },
        store.settings(),
      );
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
    expect(service.subscriberRoleCleanupExempt(otherOwner)).toBe(true);
  });

  it('does not infer Family ownership from account names, unowned mappings, or another owner', () => {
    membership();
    store.saveLink(owner, 'member', 'j-primary');
    family('emby', 'unlinked-emby-account');
    family('jellyfin', 'unlinked-jellyfin-account');
    mapping(null);
    family('emby', 'e-secondary');
    family('jellyfin', 'j-secondary');
    ownership('jellyfin', 'other-family-account', otherOwner);
    family('jellyfin', 'other-family-account');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
    expect(service.subscriberRoleCleanupExempt(otherOwner)).toBe(true);
  });

  it('rereads administrator exception and Family changes before later role removals', () => {
    membership();
    store.saveLink(owner, 'member', 'j-primary');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
    const profile = family('jellyfin', 'j-primary');
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
    service.profiles.save({ ...profile, family: false }, store.settings(), profile.revision);
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
    service.mediaOwnerships.annotate(
      `discord:${owner}`,
      { kind: 'non_media', note: 'Access approved.', approved_at: new Date().toISOString() },
      store.settings(),
    );
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
    service.mediaOwnerships.annotate(`discord:${owner}`, null, store.settings());
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
  });

  it('does not reuse old approval or Family scopes after changing the Discord server', () => {
    membership();
    ownership('jellyfin', 'j-secondary');
    family('jellyfin', 'j-secondary');
    service.mediaOwnerships.annotate(
      `discord:${owner}`,
      { kind: 'approved', note: 'Access approved.', approved_at: new Date().toISOString() },
      store.settings(),
    );
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(true);
    store.saveSettings({ ...store.settings(), discord_guild_id: '223456789012345678' });
    expect(service.subscriberRoleCleanupExempt(owner)).toBe(false);
  });
});
