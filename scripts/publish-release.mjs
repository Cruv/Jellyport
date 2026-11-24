import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseNotes } from './changelog.mjs';

const revision = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const versionRef = /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    input: options.input,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status === 0) return result.stdout.trim();
  const detail = result.stderr?.trim();
  if (detail && options.missing?.(detail)) return undefined;
  throw new Error(`${program} failed: ${detail || result.error?.message || result.status}`);
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (const [index, segment] of a.entries()) {
    if (segment !== b[index]) return segment > b[index] ? 1 : -1;
  }
  return 0;
}

/** Create a stable release from a tested multi-platform manifest. Existing names are never moved. */
export function publishRelease(
  { repo, sha, image, verifiedDigest, version, changelog },
  run = command,
) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') ||
    !revision.test(sha ?? '') ||
    !digest.test(verifiedDigest ?? '') ||
    image !== `ghcr.io/${repo.toLowerCase()}` ||
    !versionRef.test(`refs/tags/v${version}`) ||
    version.length > 64
  )
    throw new Error('Stable release metadata is invalid.');

  const notes = readReleaseNotes(changelog, version);
  if (!notes) {
    if (changelog.split(/\r?\n/).some((line) => line.startsWith(`## [${version}]`)))
      throw new Error(`Review the date and changes in CHANGELOG.md for v${version}.`);
    return `No reviewed release notes for v${version}. Stable publication skipped.`;
  }
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const tagImage = `${image}:${tag}`;
  const endpoint = `repos/${repo}`;
  const api = (path, ...args) => run('gh', ['api', `${endpoint}/${path}`, ...args]);
  const publishedRelease = () => {
    const response = run('gh', ['api', `${endpoint}/releases/tags/${tag}`], {
      missing: (message) => /\(HTTP 404\)$/.test(message),
    });
    if (response === undefined) return false;
    const release = JSON.parse(response);
    if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false)
      throw new Error(`The existing GitHub release for ${tag} conflicts with stable publication.`);
    return true;
  };
  const assertMain = () => {
    if (api('git/ref/heads/main', '--jq', '.object.sha') !== sha)
      throw new Error('Main changed. Stable publication requires the exact current main commit.');
  };
  const checkedOut = run('git', ['rev-parse', 'HEAD']);
  if (checkedOut !== sha) throw new Error('Stable release notes are not from the tested revision.');
  assertMain();

  const pages = JSON.parse(
    run('gh', ['api', '--paginate', '--slurp', `${endpoint}/git/matching-refs/tags/v`]),
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('GitHub returned invalid release references.');
  const refs = pages.flat();
  const tagged = refs.find((entry) => entry.ref === ref);
  let imageDigest = verifiedDigest;
  if (tagged) {
    const object = tagged.object;
    if (!revision.test(object?.sha ?? '')) throw new Error('The release Git reference is invalid.');
    if (object.type === 'commit')
      return `${tag} already has a Git tag. Stable publication skipped.`;
    if (object.type !== 'tag') throw new Error('The release Git reference is invalid.');
    const existing = JSON.parse(api(`git/tags/${object.sha}`));
    if (existing.tag !== tag || existing.object?.type !== 'commit')
      throw new Error('The annotated release Git tag is invalid.');
    // Freeze the first tested manifest across retries. Rebuilding even the same
    // source can refresh runtime packages and produce a different image digest.
    const marker = `Jellyport ${tag}\n\nImage manifest `;
    const pinned = existing.message?.trimEnd();
    if (!pinned?.startsWith(marker))
      return `${tag} already has an unmanaged Git tag. Stable publication skipped.`;
    imageDigest = pinned.slice(marker.length);
    if (!digest.test(imageDigest))
      throw new Error('The annotated release image digest is invalid.');
    if (existing.object.sha !== sha) {
      if (!publishedRelease())
        throw new Error(
          `${tag} is reserved for an earlier commit without a published GitHub Release.`,
        );
      return `${tag} already belongs to an earlier commit. Stable publication skipped.`;
    }
  } else if (
    refs.some((entry) => {
      const previous = versionRef.exec(entry.ref)?.[1];
      return previous && compareVersions(previous, version) > 0;
    })
  ) {
    throw new Error(`${tag} is older than an existing stable Git tag.`);
  }

  const imageDigestAt = (reference, allowMissing = false) =>
    run(
      'docker',
      ['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Manifest.Digest}}'],
      allowMissing ? { missing: (message) => message === `ERROR: ${reference}: not found` } : {},
    );
  const stableDigest = () => {
    const current = imageDigestAt(tagImage, true);
    if (current !== undefined && current !== imageDigest)
      throw new Error(`The existing image tag ${tagImage} has a different digest.`);
    return current;
  };
  const existingDigest = stableDigest();
  if (imageDigestAt(`${image}@${imageDigest}`) !== imageDigest)
    throw new Error('The tested release manifest could not be verified.');

  const existingRelease = publishedRelease();
  if (!tagged) {
    if (existingRelease)
      throw new Error(`The existing GitHub release for ${tag} conflicts with stable publication.`);
    assertMain();
    const annotated = JSON.parse(
      run('gh', ['api', '--method', 'POST', `${endpoint}/git/tags`, '--input', '-'], {
        input: JSON.stringify({
          tag,
          message: `Jellyport ${tag}\n\nImage manifest ${imageDigest}`,
          object: sha,
          type: 'commit',
          tagger: {
            name: 'github-actions[bot]',
            email: '41898282+github-actions[bot]@users.noreply.github.com',
          },
        }),
      }),
    );
    if (!revision.test(annotated.sha ?? '') || annotated.object?.sha !== sha)
      throw new Error('GitHub returned an invalid release tag object.');
    assertMain();
    // POST creates a new ref and fails if another publisher already reserved it.
    api('git/refs', '--method', 'POST', '-f', `ref=${ref}`, '-f', `sha=${annotated.sha}`);
  }
  if (existingDigest === undefined && stableDigest() === undefined) {
    assertMain();
    // The single source is the tested manifest list, so Buildx copies it exactly.
    run('docker', ['buildx', 'imagetools', 'create', '--tag', tagImage, `${image}@${imageDigest}`]);
  }
  if (imageDigestAt(tagImage) !== imageDigest)
    throw new Error('The stable image tag does not identify the tested manifest.');
  if (existingRelease) return `Verified published release ${tag}.`;

  const body = [
    `Released ${notes.date}.`,
    notes.changes.map((line) => `- ${line}`).join('\n'),
    `[Source commit \`${sha}\`](https://github.com/${repo}/commit/${sha})`,
    `Pull \`${tagImage}\` or pin the same image with \`${image}@${imageDigest}\`.`,
  ].join('\n\n');
  assertMain();
  run(
    'gh',
    [
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--verify-tag',
      '--title',
      `Jellyport ${tag}`,
      '--notes-file',
      '-',
    ],
    { input: body },
  );
  return `Published Jellyport ${tag} at ${imageDigest}.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {
      GITHUB_REPOSITORY: repo,
      SOURCE_SHA: sha,
      IMAGE_NAME: image,
      IMAGE_DIGEST: verifiedDigest,
    } = process.env;
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const changelog = readFileSync('CHANGELOG.md', 'utf8');
    console.log(publishRelease({ repo, sha, image, verifiedDigest, version, changelog }));
  } catch (error) {
    console.error(
      `Stable release failed. ${error instanceof Error ? error.message : 'Try again from the verified main revision.'}`,
    );
    process.exitCode = 1;
  }
}
