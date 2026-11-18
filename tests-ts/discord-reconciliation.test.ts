import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { startPeriodicUpkeep } from '../server/periodic-upkeep.js';

it('rotates bounded exact-owner checks and a separate member discovery cursor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jellyport-discord-reconciliation-'));
  const store = new Store(directory);
  const service = new Service(store);
  try {
    const settings = {
      ...store.settings(),
      jellyfin_url: 'http://synthetic-jellyfin.invalid',
      discord_enabled: true,
      discord_role_events: true,
      discord_guild_id: '100000000',
      discord_member_role_id: '100000001',
      auto_provision: true,
    };
    store.saveSettings(settings);
    for (let index = 0; index < 40; index++) {
      store.saveLink(String(300000000 + index), `linked-${index}`, `target-${index}`);
      service.memberships.save(
        {
          discord_user_id: String(400000000 + index),
          base_username: `membership-${index}`,
          account_limit: 1,
          tier_id: 'sloop',
          provision_jellyfin: false,
        },
        settings,
      );
    }
    const membershipActive = vi.fn(async (_id: string) => true);
    const activeMemberPage = vi.fn(async (after?: string) =>
      after === '500000050'
        ? { members: [{ id: '500000051', username: 'Discovered' }] }
        : { members: [], next: '500000050' },
    );
    service.bot = {
      membershipActive,
      activeMemberPage,
      status: () => ({ enabled: true, connected: true }),
      recipientIdentity: async (id) => ({ id, username: 'Discovered' }),
      validateRecipient: async () => {},
      sendCredentials: async () => {},
    };
    const emitted = vi.spyOn(service, 'recordSubscription').mockImplementation(async (event) => ({
      ...event,
      status: 'pending',
      created_at: new Date().toISOString(),
    }));

    for (const checks of [32, 32, 16]) {
      const prior = membershipActive.mock.calls.length;
      await service.reconcileMemberships();
      expect(membershipActive.mock.calls.length - prior).toBe(checks);
    }
    expect(new Set(membershipActive.mock.calls.map(([id]) => id)).size).toBe(80);
    expect(activeMemberPage.mock.calls).toEqual([[undefined], ['500000050'], [undefined]]);
    expect(emitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: 'role_reconciliation',
        discord_user_id: '500000051',
        action: 'subscribe',
      }),
    );
    await service.reconcileMemberships();
    expect(membershipActive.mock.calls.length).toBe(112);
  } finally {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('continues organization upkeep during stalled membership reconciliation and drains on close', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const outstanding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const membership = vi.fn(() => outstanding);
  const organization = vi.fn(async () => {});
  const stop = startPeriodicUpkeep(300_000, [membership, organization]);
  try {
    await vi.advanceTimersByTimeAsync(600_000);
    expect(membership).toHaveBeenCalledOnce();
    expect(organization).toHaveBeenCalledTimes(2);
    const drained = vi.fn();
    const stopping = stop().then(drained);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(organization).toHaveBeenCalledTimes(2);
    expect(drained).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(drained).toHaveBeenCalledOnce();
  } finally {
    release();
    await stop();
    vi.useRealTimers();
  }
});
