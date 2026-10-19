// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  jobOutcome,
  matchingCoverage,
  MigrationCoverage,
  resultOutcome,
} from './migration-outcome';
import type { Job, JobResult } from './types';
import { Status } from './components';

afterEach(cleanup);

function result(): JobResult {
  return {
    status: 'partial',
    matched: 2978,
    unmatched: 1,
    ambiguous: 12,
    applied: 37,
    already_played: 2939,
    discord_delivery: 'not_requested',
    migration_outcome: {
      version: 1,
      execution: 'verified',
      unresolved_source_history: 545,
    },
    data: {
      items_updated: 37,
      failed_items: 0,
      favorites: 0,
      resume_positions: 0,
      play_counts: 0,
      last_played_dates: 0,
      ratings: 0,
      preferences: [],
      avatar: false,
      playlists_created: 0,
      playlists_existing: 0,
      playlist_items_added: 0,
      playlist_items_skipped: 0,
      playlist_duplicates_skipped: 0,
      history_dates_missing: 0,
      warnings: ['Synthetic source-history diagnostic, classified by its server-side origin.'],
      write_metrics: {
        attempts: 37,
        succeeded: 37,
        failed: 0,
        cumulative_ms: 100,
        max_ms: 10,
        peak_in_flight: 3,
      },
      verification: {
        checked: 2976,
        verified: 2976,
        preserved_newer: 0,
        missing: 0,
        mismatched: 0,
        unsupported_fields: 0,
      },
    },
  };
}

function job(results = [result()]): Job {
  return {
    id: 'synthetic-migration',
    kind: 'migrate',
    status: 'partial',
    migration_scope: 'watched_only',
    created_at: '2026-10-19T00:00:00Z',
    results,
  };
}

describe('identifiable-source matching coverage', () => {
  it('uses matching source rows rather than writes, unique destinations or unidentified history', () => {
    const source = result();
    const coverage = matchingCoverage(source)!;
    expect(coverage).toMatchObject({
      matched: 2978,
      unmatched: 1,
      ambiguous: 12,
      total: 2991,
      meetsTarget: true,
    });
    expect(coverage.ratio).toBeCloseTo(2978 / 2991, 10);
    source.migration_outcome!.unresolved_source_history = 1000;
    source.applied = 1;
    expect(matchingCoverage(source)).toEqual(coverage);
  });

  it.each([
    [95, 5, true],
    [9499, 501, false],
    [0, 1, false],
    [1, 0, true],
  ])(
    'evaluates the unrounded coverage threshold for %i matched and %i skipped',
    (matched, skipped, meetsTarget) => {
      expect(
        matchingCoverage({ ...result(), matched, unmatched: skipped, ambiguous: 0 })?.meetsTarget,
      ).toBe(meetsTarget);
    },
  );

  it('treats zero identifiable source items as unavailable percentage rather than 100%', () => {
    expect(matchingCoverage({ ...result(), matched: 0, unmatched: 0, ambiguous: 0 })).toEqual({
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      total: 0,
      ratio: null,
      meetsTarget: false,
    });
  });

  it.each([undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '2978'])(
    'rejects a missing or invalid matching count: %s',
    (matched) => {
      expect(matchingCoverage({ ...result(), matched } as JobResult)).toBeUndefined();
    },
  );

  it('rejects an overflowing sum', () => {
    expect(
      matchingCoverage({
        ...result(),
        matched: Number.MAX_SAFE_INTEGER,
        unmatched: 1,
        ambiguous: 0,
      }),
    ).toBeUndefined();
  });
});

describe('migration execution display', () => {
  it('distinguishes high matching coverage from verified execution without mutating persisted state', () => {
    const source = result();
    const before = structuredClone(source);
    expect(resultOutcome(source, 'watched_only')).toEqual({
      value: 'partial',
      label: 'Succeeded with warnings',
      needsReview: false,
    });
    expect(source).toEqual(before);
  });

  it.each([
    [
      'absent proof',
      (value: JobResult) => {
        delete value.migration_outcome;
      },
    ],
    [
      'unclassified execution warning',
      (value: JobResult) => {
        value.migration_outcome!.execution = 'needs_review';
      },
    ],
    [
      'unknown proof version',
      (value: JobResult) => {
        (value.migration_outcome!.version as number) = 2;
      },
    ],
    [
      'missing write metrics',
      (value: JobResult) => {
        delete value.data!.write_metrics;
      },
    ],
    [
      'failed write',
      (value: JobResult) => {
        value.data!.write_metrics!.failed = 1;
      },
    ],
    [
      'unconfirmed attempted write',
      (value: JobResult) => {
        value.data!.write_metrics!.attempts = 38;
      },
    ],
    [
      'inconsistent applied count',
      (value: JobResult) => {
        value.applied = 38;
      },
    ],
    [
      'inconsistent updated count',
      (value: JobResult) => {
        value.data!.items_updated = 38;
      },
    ],
    [
      'failed item',
      (value: JobResult) => {
        value.data!.failed_items = 1;
      },
    ],
    [
      'retained failed update',
      (value: JobResult) => {
        value.data!.failed_updates = [
          { target_id: 'synthetic-target', item_type: 'Movie', error: 'Synthetic failure.' },
        ];
      },
    ],
    [
      'missing verification',
      (value: JobResult) => {
        delete value.data!.verification;
      },
    ],
    [
      'missing readback',
      (value: JobResult) => {
        value.data!.verification!.missing = 1;
      },
    ],
    [
      'mismatched readback',
      (value: JobResult) => {
        value.data!.verification!.mismatched = 1;
      },
    ],
    [
      'unsupported field',
      (value: JobResult) => {
        value.data!.verification!.unsupported_fields = 1;
      },
    ],
    [
      'incomplete readback accounting',
      (value: JobResult) => {
        value.data!.verification!.verified = 2975;
      },
    ],
    [
      'missing expected readback count',
      (value: JobResult) => {
        value.data!.verification!.checked = 0;
      },
    ],
    [
      'more verified destinations than matched source items',
      (value: JobResult) => {
        Object.assign(value.data!.verification!, { checked: 3000, verified: 3000 });
      },
    ],
    [
      'fewer verified destinations than successful writes',
      (value: JobResult) => {
        Object.assign(value.data!.verification!, { checked: 36, verified: 36 });
      },
    ],
    [
      'invalid readback count',
      (value: JobResult) => {
        value.data!.verification!.verified = Number.NaN;
      },
    ],
    [
      'invalid unresolved history count',
      (value: JobResult) => {
        value.migration_outcome!.unresolved_source_history = -1;
      },
    ],
    [
      'role warning',
      (value: JobResult) => {
        value.warnings = ['Synthetic Home preferences failure.'];
      },
    ],
    [
      'credential delivery failure',
      (value: JobResult) => {
        value.discord_delivery = 'failed';
      },
    ],
    [
      'nested credential delivery failure',
      (value: JobResult) => {
        value.discord_delivery = { status: 'failed' };
      },
    ],
    [
      'uncertain delivery state',
      (value: JobResult) => {
        value.discord_delivery = 'uncertain';
      },
    ],
    [
      'delivery error',
      (value: JobResult) => {
        value.delivery_error = 'Synthetic delivery error.';
      },
    ],
    [
      'execution error',
      (value: JobResult) => {
        value.error = 'Synthetic execution error.';
      },
    ],
    [
      'low matching coverage',
      (value: JobResult) => {
        value.unmatched = 200;
      },
    ],
  ])('retains Needs review for %s even when other matching coverage is high', (_name, change) => {
    const source = result();
    change(source);
    expect(resultOutcome(source, 'watched_only')).toEqual({ value: 'partial', needsReview: true });
  });

  it('does not classify legacy warnings by their text', () => {
    const source = result();
    delete source.migration_outcome;
    source.data!.warnings = [
      '545 saved history entries have no verified media identity. They remain unresolved and were not assumed obsolete or migrated.',
    ];
    expect(resultOutcome(source)).toEqual({ value: 'partial', needsReview: true });
  });

  it('does not promote historical broad migrations', () => {
    expect(resultOutcome(result(), 'complete')).toEqual({ value: 'partial', needsReview: true });
  });

  it('accepts verified already-played data without requiring another write', () => {
    const source = result();
    source.applied = 0;
    source.data!.items_updated = 0;
    Object.assign(source.data!.write_metrics!, { attempts: 0, succeeded: 0 });
    expect(resultOutcome(source).label).toBe('Succeeded with warnings');
  });

  it('accepts independently verified preserved destination activity', () => {
    const source = result();
    Object.assign(source.data!.verification!, { verified: 2975, preserved_newer: 1 });
    expect(resultOutcome(source).label).toBe('Succeeded with warnings');
  });

  it.each(['failed', 'interrupted', 'canceled', 'running', 'queued', 'completed'])(
    'preserves persisted %s status rather than using a percentage to change it',
    (status) => {
      expect(resultOutcome({ ...result(), status }).value).toBe(status);
      expect(resultOutcome({ ...result(), status }).label).toBeUndefined();
    },
  );
});

describe('migration job outcome', () => {
  it('refines only a finished partial migration whose results all succeeded', () => {
    expect(jobOutcome(job())).toEqual({
      value: 'partial',
      label: 'Succeeded with warnings',
      needsReview: false,
    });
    expect(jobOutcome(job([result(), { status: 'completed' }])).label).toBe(
      'Succeeded with warnings',
    );
    expect(jobOutcome({ ...job(), kind: 'migration' }).label).toBe('Succeeded with warnings');
  });

  it.each(['create', 'membership', 'role_update', 'disable'])(
    'preserves partial status for %s jobs',
    (kind) => {
      expect(jobOutcome({ ...job(), kind })).toEqual({ value: 'partial', needsReview: true });
    },
  );

  it.each([
    { error: 'Synthetic snapshot cleanup failure.' },
    { migration_scope: 'complete' as const },
    { results: [] },
    { results: [result(), { status: 'failed' }] },
    { results: [result(), { status: 'partial' }] },
    { results: [result(), { status: 'interrupted' }] },
    { results: [{ status: 'completed' }] },
  ])('keeps an operationally uncertain or unclassified job in Needs review (%j)', (changes) => {
    expect(jobOutcome({ ...job(), ...changes })).toEqual({ value: 'partial', needsReview: true });
  });
});

describe('migration coverage presentation', () => {
  it('keeps successful execution with warnings amber and explains the distinct denominators', () => {
    const source = result();
    render(
      <>
        <Status {...resultOutcome(source)} />
        <MigrationCoverage result={source} />
      </>,
    );
    expect(screen.getByText('Succeeded with warnings').className).toBe('status warn');
    const coverage = screen.getByRole('region', { name: 'Matching coverage' });
    expect(coverage.textContent).toContain('99.6% matched');
    expect(coverage.textContent).toContain('2,978 of 2,991 identifiable source items');
    expect(coverage.textContent).toContain(
      '13 identifiable source items skipped: 1 unmatched · 12 ambiguous',
    );
    expect(coverage.textContent).toContain(
      '545 saved-history rows have no verified media identity',
    );
    expect(coverage.textContent).toContain('not migrated or assumed obsolete');
    expect(coverage.textContent).toContain('not unique Jellyfin items or every saved-history row');
  });

  it('renders empty or unavailable coverage honestly', () => {
    const view = render(
      <MigrationCoverage result={{ ...result(), matched: 0, unmatched: 0, ambiguous: 0 }} />,
    );
    expect(screen.getByText('No identifiable played items')).toBeTruthy();
    expect(screen.queryByText(/100.0%/)).toBeNull();
    view.rerender(<MigrationCoverage result={{ status: 'partial' }} />);
    expect(screen.getByText('Matching coverage unavailable')).toBeTruthy();
    expect(screen.queryByText(/545/)).toBeNull();
    view.rerender(
      <MigrationCoverage result={{ status: 'running', matched: 0, unmatched: 0, ambiguous: 0 }} />,
    );
    expect(screen.getByText('Matching coverage pending')).toBeTruthy();
    expect(screen.queryByText('No identifiable played items')).toBeNull();
  });

  it('does not interpret the source count from an unknown proof version', () => {
    const source = result();
    (source.migration_outcome!.version as number) = 2;
    render(<MigrationCoverage result={source} />);
    expect(screen.queryByText(/545/)).toBeNull();
  });
});
