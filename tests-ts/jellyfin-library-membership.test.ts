import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  jellyfinAsciiPathKey,
  jellyfinLibraryConfigHash,
} from '../server/jellyfin-library-membership.js';

const id = (value: number) => value.toString(16).padStart(32, '0');
describe('neutral Jellyfin library configuration fingerprints', () => {
  it('uses normalized logical IDs and sorted exact locations in the shared canonical contract', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          [id(1), ['/A', '/b']],
          [id(2), ['/other']],
        ]),
      )
      .digest('hex');
    const entries = [
      { id: id(2).toUpperCase(), locations: ['/other'] },
      { id: '00000000-0000-0000-0000-000000000001', locations: ['/b', '/A'] },
    ];
    expect(jellyfinLibraryConfigHash(entries)).toBe(expected);
    expect(entries[1]!.locations).toEqual(['/b', '/A']);
    expect(
      jellyfinLibraryConfigHash([
        { id: id(1), locations: ['/a', '/b'] },
        { id: id(2), locations: ['/other'] },
      ]),
    ).not.toBe(expected);
    expect(
      jellyfinLibraryConfigHash([
        { id: id(1), locations: ['/A/', '/b'] },
        { id: id(2), locations: ['/other'] },
      ]),
    ).not.toBe(expected);
  });
  it('folds ASCII case only for matching and never folds Unicode accents or separators', () => {
    expect(jellyfinAsciiPathKey('/Media/TV')).toBe('/media/tv');
    expect(jellyfinAsciiPathKey('/media/Ä')).not.toBe(jellyfinAsciiPathKey('/media/ä'));
    expect(jellyfinAsciiPathKey('/media/a\\b')).not.toBe(jellyfinAsciiPathKey('/media/a/b'));
  });
  it.each(
    [
      [
        { id: id(1), locations: ['/x'] },
        { id: id(1), locations: ['/y'] },
      ],
      [{ id: 'invalid', locations: ['/x'] }],
      [{ id: id(0), locations: [] }],
      [{ id: id(1), locations: ['/x', '/x'] }],
      [{ id: id(1), locations: [''] }],
      [{ id: id(1), locations: ['/x\u0000'] }],
      [{ id: id(1), locations: ['x'.repeat(16385)] }],
      [{ id: id(1), locations: 'not-paths' }],
    ].map((entries) => ({ entries })),
  )('rejects malformed identities, duplicate paths and invalid bounded metadata', ({ entries }) => {
    expect(() => jellyfinLibraryConfigHash(entries as never)).toThrow(
      'unsupported library configuration',
    );
  });
  it('bounds collection counts, location counts and total canonical bytes', () => {
    expect(() =>
      jellyfinLibraryConfigHash(
        Array.from({ length: 1001 }, (_, index) => ({ id: id(index + 1), locations: [] })),
      ),
    ).toThrow('unsupported');
    expect(() =>
      jellyfinLibraryConfigHash([
        { id: id(1), locations: Array.from({ length: 1001 }, (_, index) => '/' + index) },
      ]),
    ).toThrow('unsupported');
    expect(() =>
      jellyfinLibraryConfigHash([
        {
          id: id(1),
          locations: Array.from({ length: 600 }, (_, index) => '/' + index + 'x'.repeat(16000)),
        },
      ]),
    ).toThrow('unsupported');
  });
});
