import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readReleaseNotes } from '../scripts/changelog.mjs';

type Run = (
  program: string,
  args: string[],
  options?: { input?: string; missing?: (message: string) => boolean },
) => string | undefined;

const { publishRelease } = (await import(
  new URL('../scripts/publish-release.mjs', import.meta.url).href
)) as {
  publishRelease(
    build: {
      repo: string;
      sha: string;
      image: string;
      verifiedDigest: string;
      version: string;
      changelog: string;
    },
    run: Run,
  ): string;
};

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const annotatedSha = 'c'.repeat(40);
const verifiedDigest = `sha256:${'1'.repeat(64)}`;
const rebuiltDigest = `sha256:${'2'.repeat(64)}`;
const repo = 'Fixture/Jellyport';
const image = 'ghcr.io/fixture/jellyport';
const version = '0.33.6';
const tag = `v${version}`;
const tagImage = `${image}:${tag}`;
const changelog =
  '# Changelog\n\n## [0.33.6] - 2026-11-24\n\n- Record the running build.\n- Publish version notes.\n\n## [0.33.5] - 2026-11-10\n\n- Older change.\n';
const build = { repo, sha, image, verifiedDigest, version, changelog };

describe('reviewed changelog sections', () => {
  it('selects the exact stable version with its date and changes', () => {
    expect(readReleaseNotes(changelog.replaceAll('\n', '\r\n'), version)).toEqual({
      date: '2026-11-24',
      changes: ['Record the running build.', 'Publish version notes.'],
    });
    expect(readReleaseNotes(changelog, '0.33.5')?.changes).toEqual(['Older change.']);
    expect(readReleaseNotes(changelog, '0.33.60')).toBeUndefined();
  });

  it.each([
    '## [0.33.6] - 2026-02-29\n\n- Incorrect date.',
    '## [0.33.6] - 2026-11-24\n',
    '## [0.33.6] - 2026-11-24\n\nSomeone omitted the list marker.',
    `${changelog}\n## [0.33.6] - 2026-11-24\n\n- Duplicate heading.\n`,
  ])('rejects malformed release content', (content) => {
    expect(readReleaseNotes(content, version)).toBeUndefined();
  });
});

function fixture() {
  const state = {
    main: sha,
    checkout: sha,
    taggedImage: undefined as string | undefined,
    release: undefined as { tag_name: string; draft: boolean; prerelease: boolean } | undefined,
    releaseBody: '',
    refs: new Map<string, { type: string; sha: string }>(),
    annotated: undefined as
      | { sha: string; tag: string; message: string; object: { type: string; sha: string } }
      | undefined,
    updates: [] as string[],
    failRelease: false,
    moveMainAfterTag: false,
    replaceImageAfterTag: false,
  };

  const run: Run = (program, args, options) => {
    if (program === 'git' && args.join(' ') === 'rev-parse HEAD') return state.checkout;
    if (program === 'docker') {
      if (args[2] === 'inspect') {
        const reference = args[3]!;
        if (reference === tagImage) {
          if (state.taggedImage !== undefined) return state.taggedImage;
          const message = `ERROR: ${tagImage}: not found`;
          if (options?.missing?.(message)) return undefined;
          throw new Error(message);
        }
        const value = reference.split('@')[1];
        if (value === verifiedDigest || value === rebuiltDigest) return value;
      }
      if (args[2] === 'create' && args[3] === '--tag' && args[4] === tagImage) {
        state.updates.push('stable image');
        state.taggedImage = args[5]?.split('@')[1];
        return '';
      }
    }
    if (program === 'gh' && args[0] === 'api') {
      const reference = args.find((arg) => arg.startsWith(`repos/${repo}/`));
      if (reference?.endsWith('/git/ref/heads/main')) return state.main;
      if (reference?.endsWith('/git/matching-refs/tags/v')) {
        const tags = [...state.refs].map(([ref, object]) => ({ ref, object }));
        const split = Math.ceil(tags.length / 2);
        return JSON.stringify([tags.slice(0, split), tags.slice(split)]);
      }
      if (reference?.endsWith('/git/tags') && args.includes('POST')) {
        state.updates.push('tag object');
        const { tag, message, object, type } = JSON.parse(options?.input ?? '{}');
        state.annotated = { sha: annotatedSha, tag, message, object: { sha: object, type } };
        return JSON.stringify(state.annotated);
      }
      if (reference?.endsWith(`/git/tags/${annotatedSha}`)) return JSON.stringify(state.annotated);
      if (reference?.endsWith('/git/refs') && args.includes('POST')) {
        state.updates.push('Git reference');
        expect(args).toContain(`ref=refs/tags/${tag}`);
        expect(args).toContain(`sha=${annotatedSha}`);
        state.refs.set(`refs/tags/${tag}`, { type: 'tag', sha: annotatedSha });
        if (state.moveMainAfterTag) state.main = otherSha;
        if (state.replaceImageAfterTag) state.taggedImage = rebuiltDigest;
        return '';
      }
      if (reference?.endsWith(`/releases/tags/${tag}`)) {
        if (state.release) return JSON.stringify(state.release);
        if (options?.missing?.('gh: Not Found (HTTP 404)')) return undefined;
      }
    }
    if (program === 'gh' && args[0] === 'release' && args[1] === 'create') {
      if (state.failRelease) throw new Error('Synthetic transport interruption');
      expect(args).toContain('--verify-tag');
      expect(args).toContain(tag);
      state.updates.push('GitHub release');
      state.release = { tag_name: tag, draft: false, prerelease: false };
      state.releaseBody = options?.input ?? '';
      return '';
    }
    throw new Error(`Unexpected fixture command ${program} ${args.join(' ')}`);
  };
  return { state, run };
}

describe('stable release promotion', () => {
  it('publishes the exact tested manifest, then publishes the reviewed GitHub release', () => {
    const { state, run } = fixture();
    expect(publishRelease(build, run)).toContain(verifiedDigest);
    expect(state.updates).toEqual([
      'tag object',
      'Git reference',
      'stable image',
      'GitHub release',
    ]);
    expect(state.taggedImage).toBe(verifiedDigest);
    expect(state.annotated?.object.sha).toBe(sha);
    expect(state.releaseBody).toContain('Released 2026-11-24.');
    expect(state.releaseBody).toContain('- Record the running build.\n- Publish version notes.');
    expect(state.releaseBody).not.toContain('Older change.');
    expect(state.releaseBody).toContain(`https://github.com/${repo}/commit/${sha}`);
    expect(state.releaseBody).toContain(`${image}@${verifiedDigest}`);
  });

  it('resumes an interrupted release without retagging a rebuilt same-revision image', () => {
    const { state, run } = fixture();
    state.failRelease = true;
    expect(() => publishRelease(build, run)).toThrow('Synthetic transport interruption');
    expect(state.taggedImage).toBe(verifiedDigest);
    expect(state.release).toBeUndefined();
    state.failRelease = false;
    const rebuilt = { ...build, verifiedDigest: rebuiltDigest };
    expect(publishRelease(rebuilt, run)).toContain(verifiedDigest);
    expect(publishRelease(rebuilt, run)).toBe(`Verified published release ${tag}.`);
    expect(state.taggedImage).toBe(verifiedDigest);
    expect(state.updates).toEqual([
      'tag object',
      'Git reference',
      'stable image',
      'GitHub release',
    ]);
  });

  it('resumes from a pinned Git reference when publication stops before the registry tag', () => {
    const { state, run } = fixture();
    state.moveMainAfterTag = true;
    expect(() => publishRelease(build, run)).toThrow('exact current main commit');
    expect(state.updates).toEqual(['tag object', 'Git reference']);
    state.moveMainAfterTag = false;
    state.main = sha;
    publishRelease({ ...build, verifiedDigest: rebuiltDigest }, run);
    expect(state.taggedImage).toBe(verifiedDigest);
    expect(state.release).toBeDefined();
  });

  it('keeps the version on its original commit when a new commit uses the same version', () => {
    const { state, run } = fixture();
    publishRelease(build, run);
    state.main = otherSha;
    state.checkout = otherSha;
    const next = { ...build, sha: otherSha, verifiedDigest: rebuiltDigest };
    expect(publishRelease(next, run)).toContain('belongs to an earlier commit');
    expect(state.taggedImage).toBe(verifiedDigest);
    expect(state.updates).toEqual([
      'tag object',
      'Git reference',
      'stable image',
      'GitHub release',
    ]);
  });

  it('reports an incomplete release reserved by an earlier revision', () => {
    const { state, run } = fixture();
    state.failRelease = true;
    expect(() => publishRelease(build, run)).toThrow('Synthetic transport interruption');
    state.main = otherSha;
    state.checkout = otherSha;
    expect(() =>
      publishRelease({ ...build, sha: otherSha, verifiedDigest: rebuiltDigest }, run),
    ).toThrow('reserved for an earlier commit without a published GitHub Release');
    expect(state.updates).toEqual(['tag object', 'Git reference', 'stable image']);
  });

  it('does not mark a new lower version as latest, including tags on later pages', () => {
    const { state, run } = fixture();
    state.refs.set('refs/tags/v0.33.5', { sha, type: 'commit' });
    state.refs.set('refs/tags/v0.33.10', { sha, type: 'commit' });
    expect(() => publishRelease(build, run)).toThrow('older than an existing stable Git tag');
    expect(state.updates).toEqual([]);
  });

  it('reports a registry tag conflict before creating the Git tag', () => {
    const { state, run } = fixture();
    state.taggedImage = rebuiltDigest;
    expect(() => publishRelease(build, run)).toThrow('has a different digest');
    expect(state.updates).toEqual([]);
  });

  it('rejects a conflicting tag that appears while Git release publication is being prepared', () => {
    const { state, run } = fixture();
    state.replaceImageAfterTag = true;
    expect(() => publishRelease(build, run)).toThrow('has a different digest');
    expect(state.updates).toEqual(['tag object', 'Git reference']);
    expect(state.taggedImage).toBe(rebuiltDigest);
  });

  it('rejects published metadata from a checkout other than the tested commit', () => {
    const { state, run } = fixture();
    state.checkout = otherSha;
    expect(() => publishRelease(build, run)).toThrow('notes are not from the tested revision');
    expect(state.updates).toEqual([]);
  });

  it('keeps building exact images for versions without reviewed release notes', () => {
    const { state, run } = fixture();
    expect(publishRelease({ ...build, version: '0.34.0' }, run)).toContain(
      'No reviewed release notes',
    );
    expect(state.updates).toEqual([]);
  });

  it('fails for an existing but malformed release entry', () => {
    const { state, run } = fixture();
    expect(() =>
      publishRelease({ ...build, changelog: '## [0.33.6] - 2025-02-29\n\n- Bad date.\n' }, run),
    ).toThrow('Review the date and changes');
    expect(state.updates).toEqual([]);
  });

  it('only grants GitHub contents write after both smoke tests and manifest publication', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/docker-publish.yml', import.meta.url),
      'utf8',
    );
    const [imageWorkflow, releaseWorkflow] = workflow.split('\n  release:\n');
    expect(imageWorkflow).toContain('publish:\n    needs: [verify, build]');
    expect(imageWorkflow).not.toContain('contents: write');
    expect(imageWorkflow).toContain('--metadata-file "$manifest_metadata"');
    expect(imageWorkflow).toContain('jq -er \'."containerimage.descriptor".digest\'');
    expect(imageWorkflow).toContain('[[ "$promoted" == "$manifest_digest" ]]');
    expect(releaseWorkflow).toContain('needs: [verify, publish]');
    expect(releaseWorkflow).toContain('IMAGE_DIGEST: ${{ needs.publish.outputs.digest }}');
    expect(releaseWorkflow).toContain('contents: write');
  });
});
