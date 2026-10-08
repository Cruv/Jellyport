import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/types.js';
import {
  DEFAULT_MEMBERSHIP_TIERS,
  Memberships,
  membershipUsername,
  resolveMembershipTier,
  validateMembershipTiers,
  type MembershipInput,
} from '../server/memberships.js';

const directories: string[] = [];
const stores: Store[] = [];
const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  jellyfin_url: 'https://jellyfin.example',
};
const input = (fields: Partial<MembershipInput> = {}): MembershipInput => ({
  discord_user_id: '123456789',
  base_username: 'Jim',
  tier_id: 'brigantine',
  account_limit: 2,
  ...fields,
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-memberships-'));
  directories.push(directory);
  const store = new Store(directory);
  stores.push(store);
  return { directory, store, memberships: new Memberships(store) };
}
function bindServer(store: Store, serverId: string) {
  const pending = store.ensureAuthState();
  if (pending.kind !== 'pending') throw new Error('Expected pending fixture');
  store.completeAuth(
    pending.generation,
    { kind: 'configured', serverUrl: settings.jellyfin_url, serverId, apiKeyName: 'fixture' },
    () => structuredClone(settings),
  );
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('membership tiers and slot names', () => {
  it('uses the three configured account entitlements and exact plan names', () => {
    expect(DEFAULT_MEMBERSHIP_TIERS.map((value) => [value.id, value.account_limit])).toEqual([
      ['sloop', 1],
      ['brigantine', 2],
      ['galleon', 3],
    ]);
    expect(resolveMembershipTier(' Brigantine Crewman Plan ')?.account_limit).toBe(2);
    expect(resolveMembershipTier('galleon crewman plan')?.account_limit).toBe(3);
    for (const unknown of [
      'Brigantine',
      'Premium Brigantine Crewman Plan',
      'Galleon Crewman Plan expired',
      '',
      'unconfigured plan',
    ])
      expect(resolveMembershipTier(unknown)).toBeNull();
    const custom = validateMembershipTiers([
      {
        id: 'crew',
        name: 'Crew',
        plan_name: 'My custom plan',
        account_limit: 2,
      },
    ]);
    expect(custom[0]).toEqual({
      id: 'crew',
      name: 'Crew',
      plan_name: 'My custom plan',
      account_limit: 2,
    });
    expect(resolveMembershipTier('Sloop Crewman Plan', custom)).toBeNull();
  });
  it.each(
    [
      [],
      Array.from({ length: 21 }, (_, index) => ({
        id: `tier${index}`,
        name: 'Tier',
        plan_name: `Plan ${index}`,
        account_limit: 1,
      })),
      [{ id: 'unsafe/id', name: 'Tier', plan_name: 'Plan', account_limit: 1 }],
      [{ id: 'tier', name: 'Tier', plan_name: 'Plan\nsecret', account_limit: 1 }],
      [{ id: 'tier', name: 'Tier', plan_name: 'Plan', account_limit: 4 }],
      [{ id: 'tier', name: 'Tier', plan_name: 'Plan', account_limit: 1.5 }],
      [
        {
          id: 'tier',
          name: 'Tier',
          plan_name: 'Plan',
          account_limit: 1,
          private_metadata: 'unexpected',
        },
      ],
      [
        { id: 'tier', name: 'Tier', plan_name: 'Plan', account_limit: 1 },
        { id: 'TIER', name: 'Other', plan_name: 'Other plan', account_limit: 2 },
      ],
      [
        { id: 'tier', name: 'Tier', plan_name: 'Plan', account_limit: 1 },
        { id: 'other', name: 'Other', plan_name: 'PLAN', account_limit: 2 },
      ],
    ].map((tiers) => ({ tiers })),
  )('rejects malformed or ambiguous tiers %#', ({ tiers }) => {
    expect(() => validateMembershipTiers(tiers)).toThrow();
  });
  it('generates deterministic numbered usernames without silently truncating them', () => {
    expect([1, 2, 3].map((slot) => membershipUsername('Jim', slot))).toEqual([
      'Jim',
      'Jim_2',
      'Jim_3',
    ]);
    expect(membershipUsername('x'.repeat(62), 3)).toHaveLength(64);
    expect(() => membershipUsername('x'.repeat(63), 2)).toThrow('too long');
    for (const base of [' Jim', 'Jim ', 'Jim\n', '../Jim', 'Jim/name', '<Jim>'])
      expect(() => membershipUsername(base, 1)).toThrow();
    expect(() => membershipUsername('Jim', 4)).toThrow('slots');
  });
});

describe('encrypted scoped memberships', () => {
  it('preserves revisions for idempotent saves and revises changed limits, names, and active state', () => {
    const { memberships } = fixture();
    const initial = memberships.save(input(), settings);
    expect(initial.active).toBe(true);
    expect(initial.access_mode).toBe('subscription');
    expect(memberships.get('123456789', settings)).toEqual(initial);
    expect(memberships.save(input(), settings, initial.revision)).toEqual(initial);
    const upgraded = memberships.save(
      input({ tier_id: 'galleon', account_limit: 3 }),
      settings,
      initial.revision,
    );
    expect(upgraded.revision).not.toBe(initial.revision);
    expect(() => memberships.save(input(), settings, initial.revision)).toThrow('changed');
    const inactive = memberships.save({ ...upgraded, active: false }, settings, upgraded.revision);
    expect(inactive.revision).not.toBe(upgraded.revision);
    expect(inactive.active).toBe(false);
    const renamed = memberships.save(
      { ...inactive, base_username: 'Approved.alias' },
      settings,
      inactive.revision,
    );
    expect(renamed.revision).not.toBe(inactive.revision);
    expect(renamed.active).toBe(false);
  });
  it('persists complimentary access and revises changes between access modes', () => {
    const { memberships } = fixture();
    const initial = memberships.save(input(), settings);
    const complimentary = memberships.save(
      { ...initial, access_mode: 'complimentary', tier_id: 'complimentary' },
      settings,
      initial.revision,
    );
    expect(complimentary.access_mode).toBe('complimentary');
    expect(complimentary.revision).not.toBe(initial.revision);
    expect(memberships.get(initial.discord_user_id, settings)).toEqual(complimentary);
    expect(memberships.save({ ...complimentary }, settings, complimentary.revision)).toEqual(
      complimentary,
    );
    const subscription = memberships.save(
      { ...complimentary, access_mode: 'subscription' },
      settings,
      complimentary.revision,
    );
    expect(subscription.access_mode).toBe('subscription');
    expect(subscription.revision).not.toBe(complimentary.revision);
    expect(() => memberships.save(complimentary, settings, complimentary.revision)).toThrow(
      'changed',
    );
  });
  it('normalizes legacy records to subscription access without invalidating their revision', () => {
    const { memberships, store } = fixture();
    const saved = memberships.save(input(), settings);
    const { id } = store.membershipRecords()[0]!;
    const { access_mode: _accessMode, ...legacy } = saved;
    store.saveMembershipRecord(id, legacy);
    expect(memberships.get(saved.discord_user_id, settings)).toEqual(saved);
    expect(memberships.list(settings)).toEqual([saved]);
    expect(memberships.save(input(), settings, saved.revision)).toEqual(saved);
  });
  it('revises a change to the access mode even when every other field is unchanged', () => {
    const { memberships } = fixture();
    const saved = memberships.save(input(), settings);
    const complimentary = memberships.save(
      { ...saved, access_mode: 'complimentary' },
      settings,
      saved.revision,
    );
    expect(complimentary.revision).not.toBe(saved.revision);
    expect(complimentary).toEqual({
      ...saved,
      access_mode: 'complimentary',
      revision: complimentary.revision,
    });
    // An omitted mode is the legacy subscription default, never an implicit exemption.
    expect(memberships.save(input(), settings, complimentary.revision).access_mode).toBe(
      'subscription',
    );
  });
  it('scopes records to normalized server URL and configured authentication server identity', () => {
    const { memberships, store } = fixture();
    bindServer(store, 'server-one');
    const saved = memberships.save(input(), {
      ...settings,
      jellyfin_url: 'https://JELLYFIN.example:443/',
    });
    expect(saved.server_url).toBe(settings.jellyfin_url);
    expect(saved.server_id).toBe('server-one');
    expect(memberships.list(settings)).toEqual([saved]);
    expect(memberships.list({ ...settings, jellyfin_url: 'https://other.example' })).toEqual([]);
    expect(() =>
      memberships.save(input(), { ...settings, jellyfin_url: 'https://other.example' }),
    ).toThrow('Configure');
    store.db.prepare('UPDATE auth_state SET encrypted=? WHERE id=1').run(
      store.encrypt({
        kind: 'configured',
        serverUrl: settings.jellyfin_url,
        serverId: 'replacement-server',
        apiKeyName: 'fixture',
      }),
    );
    expect(memberships.get('123456789', settings)).toBeNull();
    expect(() => memberships.save(input(), settings, saved.revision)).toThrow('changed');
  });
  it('does not activate URL-only records after an authenticated server binding is established', () => {
    const { store, memberships } = fixture();
    const saved = memberships.save(input(), settings);
    expect(saved.server_id).toBeUndefined();
    bindServer(store, 'new-authenticated-server');
    expect(memberships.list(settings)).toEqual([]);
    expect(memberships.hasOtherScope('123456789', settings)).toBe(true);
    expect(memberships.hasOtherScope('987654321', settings)).toBe(false);
  });
  it('distinguishes true legacy members from members bound to another URL or server identity', () => {
    const { memberships, store } = fixture();
    bindServer(store, 'server-one');
    expect(memberships.hasOtherScope('123456789', settings)).toBe(false);
    memberships.save(input(), settings);
    expect(memberships.hasOtherScope('123456789', settings)).toBe(false);
    const other = { ...settings, jellyfin_url: 'https://other.example' };
    expect(memberships.get('123456789', other)).toBeNull();
    expect(memberships.hasOtherScope('123456789', other)).toBe(true);
    store.db.prepare('UPDATE auth_state SET encrypted=? WHERE id=1').run(
      store.encrypt({
        kind: 'configured',
        serverUrl: settings.jellyfin_url,
        serverId: 'replacement-server',
        apiKeyName: 'fixture',
      }),
    );
    expect(memberships.hasOtherScope('123456789', settings)).toBe(true);
  });
  it('persists inactive reasons, revises changed reasons, and clears cancellation holds when renewed', () => {
    const { memberships } = fixture();
    const active = memberships.save(input(), settings);
    const cancelled = memberships.save(
      input({ active: false, inactive_reason: 'cancel' }),
      settings,
      active.revision,
    );
    expect(cancelled).toMatchObject({ active: false, inactive_reason: 'cancel' });
    expect(cancelled.revision).not.toBe(active.revision);
    expect(
      memberships.save(
        input({ active: false, inactive_reason: 'cancel' }),
        settings,
        cancelled.revision,
      ),
    ).toEqual(cancelled);
    const expired = memberships.save(
      { ...cancelled, inactive_reason: 'expire' },
      settings,
      cancelled.revision,
    );
    expect(expired.revision).not.toBe(cancelled.revision);
    const renewed = memberships.save({ ...expired, active: true }, settings, expired.revision);
    expect(renewed.active).toBe(true);
    expect(renewed.inactive_reason).toBeUndefined();
    expect(renewed.revision).not.toBe(expired.revision);
    expect(
      memberships.save(input({ inactive_reason: 'cancel' }), settings, renewed.revision),
    ).toEqual(renewed);
    expect(memberships.get('123456789', settings)).toEqual(renewed);
  });
  it('encrypts identity and entitlement details in the database and WAL and emits only approved fields', () => {
    const { directory, memberships, store } = fixture();
    const saved = memberships.save(
      input({ base_username: 'Private.membership.alias', access_mode: 'complimentary' }),
      settings,
    );
    for (const name of ['jellyport.db', 'jellyport.db-wal']) {
      const bytes = readFileSync(join(directory, name));
      for (const secret of [
        '123456789',
        'Private.membership.alias',
        settings.jellyfin_url,
        'brigantine',
        'complimentary',
      ])
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
    const record = store.membershipRecords<Record<string, unknown>>()[0]!;
    store.saveMembershipRecord(record.id, {
      ...record.value,
      access_token: 'private-token',
      session: 'private-session',
    });
    expect(memberships.get(saved.discord_user_id, settings)).toEqual(saved);
    expect(JSON.stringify(memberships.list(settings))).not.toContain('private-token');
  });
  it.each([
    { discord_user_id: 'invalid' },
    { discord_user_id: 123456789 },
    { account_limit: 0 },
    { account_limit: 4 },
    { account_limit: 1.5 },
    { active: 'true' },
    { inactive_reason: 'unsupported' },
    { access_mode: 'free' },
    { access_mode: null },
    { access_mode: true },
    { access_mode: '' },
    { base_username: 'x'.repeat(63), account_limit: 2 },
    { tier_id: '../tier' },
  ])('rejects invalid membership inputs %#', (fields) => {
    const { memberships } = fixture();
    expect(() => memberships.save(input(fields as Partial<MembershipInput>), settings)).toThrow();
    expect(memberships.list(settings)).toEqual([]);
  });
  it('fails closed on corrupted encrypted record identifiers', () => {
    const { memberships, store } = fixture();
    const saved = memberships.save(input(), settings);
    store.saveMembershipRecord('invalid-record-id', saved);
    expect(() => memberships.list(settings)).toThrow('identity');
  });
  it('fails closed on a malformed access mode in a saved record', () => {
    const { memberships, store } = fixture();
    const saved = memberships.save(input(), settings);
    const { id } = store.membershipRecords()[0]!;
    store.saveMembershipRecord(id, { ...saved, access_mode: 'unexpected' });
    expect(() => memberships.get(saved.discord_user_id, settings)).toThrow('identity');
    expect(() => memberships.list(settings)).toThrow('identity');
  });
  it('authenticates a directly resolved record against its scoped identifier and observes later changes', () => {
    const { memberships, store } = fixture();
    const saved = memberships.save(input(), settings);
    const { id } = store.membershipRecords()[0]!;
    store.saveMembershipRecord(id, {
      ...saved,
      active: false,
      inactive_reason: 'cancel',
      private_token: 'private',
    });
    expect(memberships.get('123456789', settings)).toMatchObject({
      active: false,
      inactive_reason: 'cancel',
    });
    expect(JSON.stringify(memberships.get('123456789', settings))).not.toContain('private_token');
    store.saveMembershipRecord(id, { ...saved, discord_user_id: '987654321' });
    expect(() => memberships.get('123456789', settings)).toThrow('identity');
  });
});
