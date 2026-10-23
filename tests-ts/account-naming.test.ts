import { describe, expect, it } from 'vitest';
import {
  parseAccountUsername,
  renderAccountUsername,
  validateAccountNaming,
} from '../server/account-naming.js';
import { validateSettings } from '../server/settings.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

describe('shared literal account naming', () => {
  it('preserves default names and parses only supported terminal slots', () => {
    expect([1, 2, 3].map((slot) => renderAccountUsername('river', slot))).toEqual([
      'river',
      'river_2',
      'river_3',
    ]);
    expect(parseAccountUsername('river_2')).toEqual({ base: 'river', slot: 2 });
    expect(parseAccountUsername('river_2_3')).toEqual({ base: 'river_2', slot: 3 });
    for (const name of ['river_02', 'river_4', 'river_20'])
      expect(parseAccountUsername(name)).toEqual({ base: name, slot: 1 });
  });
  it('round trips literal prefix/suffix formats and historical aliases without executing names', () => {
    const policy = {
      account_name_primary: 'media-{username}',
      account_name_additional: 'media-{username}-profile{slot}',
      account_name_aliases: ['{username}_{slot}'],
    };
    validateAccountNaming(policy);
    expect(renderAccountUsername('river{slot}', 3, policy)).toBe('media-river{slot}-profile3');
    expect(parseAccountUsername('media-river-profile2', policy)).toEqual({
      base: 'river',
      slot: 2,
    });
    expect(parseAccountUsername('river_3', policy)).toEqual({ base: 'river', slot: 3 });
    expect(parseAccountUsername('media-river', policy)).toEqual({ base: 'river', slot: 1 });
  });
  it.each([
    '{username}',
    '{username}_{slot}_{slot}',
    '{username}/{slot}',
    '{username}\n{slot}',
    '{user}_{slot}',
    '.*',
    '{username}_{slot}{code}',
  ])('rejects invalid additional formats %s', (format) => {
    expect(() => validateAccountNaming({ account_name_additional: format })).toThrow();
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, account_name_additional: format }),
    ).toThrow();
  });
  it('rejects oversize names, aliases and ambiguous inverse matches', () => {
    expect(() => renderAccountUsername('x'.repeat(63), 2)).toThrow('64');
    expect(() =>
      validateAccountNaming({
        account_name_aliases: Array.from({ length: 9 }, (_, i) => `{username}-${i}-{slot}`),
      }),
    ).toThrow('eight');
    expect(
      parseAccountUsername('river_2', { account_name_aliases: ['{username}{slot}'] }),
    ).toBeNull();
  });
});
