import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const identityFile = 'ci-build-identity.json';
const failure = () =>
  new Error('CI verification evidence is incomplete or does not match this run.');

/** The required check cannot treat skipped/canceled dependencies as a runtime pass. */
export function runtimeGate(needs) {
  if (
    !needs ||
    typeof needs !== 'object' ||
    Array.isArray(needs) ||
    Object.keys(needs).sort().join(',') !== 'browser,scope,unit' ||
    needs.scope?.result !== 'success'
  )
    throw failure();
  const docsOnly = needs.scope.outputs?.docs_only;
  if (docsOnly === 'true') {
    if (needs.unit?.result !== 'skipped' || needs.browser?.result !== 'skipped') throw failure();
    return 'docs';
  }
  if (
    docsOnly !== 'false' ||
    needs.unit?.result !== 'success' ||
    needs.browser?.result !== 'success'
  )
    throw failure();
  return 'runtime';
}

function buildIdentity(environment) {
  const sha = environment.GITHUB_SHA;
  const runId = environment.GITHUB_RUN_ID;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[1-9][0-9]{0,19}$/.test(runId ?? '')) throw failure();
  return { format: 1, sha, run_id: runId };
}

/** An absent ID must never turn an exact-artifact download into download-all. */
export function verifyBuildArtifactId(value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw failure();
}

/** Bind the immutable artifact to its own workflow run and checked-out revision. */
export function writeBuildIdentity(directory, environment = process.env) {
  const value = buildIdentity(environment);
  if (!lstatSync(directory).isDirectory()) throw failure();
  writeFileSync(join(directory, identityFile), JSON.stringify(value), { flag: 'wx' });
}

export function verifyBuildIdentity(directory, environment = process.env) {
  const path = join(directory, identityFile);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw failure();
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const expected = buildIdentity(environment);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'format,run_id,sha' ||
    value.format !== expected.format ||
    value.sha !== expected.sha ||
    value.run_id !== expected.run_id
  )
    throw failure();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, ...extra] = process.argv.slice(2);
    if (extra.length) throw failure();
    if (command === 'gate' && directory === undefined) {
      if (Buffer.byteLength(process.env.CI_NEEDS ?? '') > 16_384) throw failure();
      const kind = runtimeGate(JSON.parse(process.env.CI_NEEDS ?? 'null'));
      console.log(`${kind === 'runtime' ? 'Runtime' : 'Documentation'} dependencies verified.`);
    } else if (command === 'artifact-id' && directory === undefined) {
      verifyBuildArtifactId(process.env.CI_BUILD_ARTIFACT_ID);
    } else if (command === 'build-write' && directory) {
      writeBuildIdentity(directory);
    } else if (command === 'build-verify' && directory) {
      verifyBuildIdentity(directory);
      console.log('Same-run build revision verified.');
    } else throw failure();
  } catch {
    console.error('CI verification evidence is incomplete or does not match this run.');
    process.exitCode = 1;
  }
}
