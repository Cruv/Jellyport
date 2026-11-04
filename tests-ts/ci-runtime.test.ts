import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const { runtimeGate, verifyBuildArtifactId, writeBuildIdentity, verifyBuildIdentity } =
  (await import(new URL('../scripts/ci-runtime.mjs', import.meta.url).href)) as {
    runtimeGate(needs: unknown): 'docs' | 'runtime';
    verifyBuildArtifactId(value: unknown): void;
    writeBuildIdentity(directory: string, environment?: Record<string, string>): void;
    verifyBuildIdentity(directory: string, environment?: Record<string, string>): void;
  };

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/ci-runtime.mjs');
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const runtimeNeeds = () => ({
  scope: { result: 'success', outputs: { docs_only: 'false' } },
  unit: { result: 'success' },
  browser: { result: 'success' },
});
const docsNeeds = () => ({
  scope: { result: 'success', outputs: { docs_only: 'true' } },
  unit: { result: 'skipped' },
  browser: { result: 'skipped' },
});

function command(args: string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function job(name: string) {
  const begin = workflow.indexOf(`\n  ${name}:\n`);
  if (begin < 0) throw new Error(`Required CI job ${name} is missing.`);
  const rest = workflow.slice(begin + `\n  ${name}:\n`.length);
  const next = rest.search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function steps(body: string) {
  return body.split(/^      - /m).slice(1);
}

function namedStep(body: string, name: string) {
  const matching = steps(body).filter((step) => step.startsWith(`name: ${name}\n`));
  expect(matching, `${name} must occur exactly once`).toHaveLength(1);
  return matching[0];
}

describe('required runtime result aggregation', () => {
  it('accepts runtime only after scope, unit/build/audit and the entire browser matrix succeed', () => {
    expect(runtimeGate(runtimeNeeds())).toBe('runtime');
    expect(runtimeGate(docsNeeds())).toBe('docs');
  });

  for (const dependency of ['unit', 'browser'] as const) {
    it.each(['failure', 'cancelled', 'skipped', '', undefined])(
      `rejects a %s ${dependency} result for runtime changes`,
      (result) => {
        const needs = runtimeNeeds();
        Object.assign(needs[dependency], { result });
        expect(() => runtimeGate(needs)).toThrow();
      },
    );

    it.each(['failure', 'cancelled', 'success', '', undefined])(
      `rejects a %s ${dependency} result on the documentation-only path`,
      (result) => {
        const needs = docsNeeds();
        Object.assign(needs[dependency], { result });
        expect(() => runtimeGate(needs)).toThrow();
      },
    );
  }

  it.each(['failure', 'cancelled', 'skipped', '', undefined])(
    'cannot bypass an unsuccessful scope result (%s)',
    (result) => {
      for (const needs of [runtimeNeeds(), docsNeeds()]) {
        Object.assign(needs.scope, { result });
        expect(() => runtimeGate(needs)).toThrow();
      }
    },
  );

  it.each([undefined, '', 'TRUE', false, true, null])(
    'rejects absent or nonliteral scope classification (%s)',
    (docs_only) => {
      const needs = runtimeNeeds();
      Object.assign(needs.scope.outputs, { docs_only });
      expect(() => runtimeGate(needs)).toThrow();
    },
  );

  it('rejects missing, renamed or unexpected dependencies', () => {
    for (const name of ['scope', 'unit', 'browser']) {
      const needs: Record<string, unknown> = runtimeNeeds();
      delete needs[name];
      expect(() => runtimeGate(needs)).toThrow();
    }
    expect(() => runtimeGate({ ...runtimeNeeds(), another: { result: 'success' } })).toThrow();
    for (const value of [undefined, null, [], 'success', {}])
      expect(() => runtimeGate(value)).toThrow();
  });

  it('executes the actual CLI fail-closed before the success marker can run', () => {
    const pass = command(['gate'], { CI_NEEDS: JSON.stringify(runtimeNeeds()) });
    expect(pass.status, pass.stderr).toBe(0);
    expect(pass.stdout).toBe('Runtime dependencies verified.\n');
    const docs = command(['gate'], { CI_NEEDS: JSON.stringify(docsNeeds()) });
    expect(docs.status, docs.stderr).toBe(0);
    expect(docs.stdout).toBe('Documentation dependencies verified.\n');
    const failed = runtimeNeeds();
    failed.browser.result = 'failure';
    for (const value of [JSON.stringify(failed), '{private-fixture', 'x'.repeat(16_385)]) {
      const result = command(['gate'], { CI_NEEDS: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'CI verification evidence is incomplete or does not match this run.\n',
      );
    }
  });
});

describe('same-run immutable browser build', () => {
  const identity = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42' };

  function withDirectory(check: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-ci-build-'));
    try {
      check(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('writes once and accepts the same run/revision on a failed-job rerun', () => {
    withDirectory((directory) => {
      writeBuildIdentity(directory, { ...identity, GITHUB_RUN_ATTEMPT: '1' });
      expect(() =>
        verifyBuildIdentity(directory, { ...identity, GITHUB_RUN_ATTEMPT: '2' }),
      ).not.toThrow();
      expect(() => writeBuildIdentity(directory, identity)).toThrow();
      expect(JSON.parse(readFileSync(join(directory, 'ci-build-identity.json'), 'utf8'))).toEqual({
        format: 1,
        sha: identity.GITHUB_SHA,
        run_id: identity.GITHUB_RUN_ID,
      });
    });
  });

  it('rejects a build from another run or revision and incomplete identity metadata', () => {
    withDirectory((directory) => {
      writeBuildIdentity(directory, identity);
      for (const environment of [
        { ...identity, GITHUB_SHA: 'b'.repeat(40) },
        { ...identity, GITHUB_RUN_ID: '43' },
        { ...identity, GITHUB_SHA: '' },
        { ...identity, GITHUB_RUN_ID: '0' },
        { ...identity, GITHUB_RUN_ID: '' },
      ])
        expect(() => verifyBuildIdentity(directory, environment)).toThrow();
    });
  });

  it('rejects missing, malformed, oversized or extra build metadata', () => {
    withDirectory((directory) => {
      expect(() => verifyBuildIdentity(directory, identity)).toThrow();
      for (const value of [
        'null',
        '[]',
        '{',
        ' '.repeat(1025),
        JSON.stringify({ format: 2, sha: identity.GITHUB_SHA, run_id: '42' }),
        JSON.stringify({ format: 1, sha: identity.GITHUB_SHA, run_id: 42 }),
        JSON.stringify({ format: 1, sha: identity.GITHUB_SHA }),
        JSON.stringify({ format: 1, sha: identity.GITHUB_SHA, run_id: '42', untrusted: true }),
      ]) {
        writeFileSync(join(directory, 'ci-build-identity.json'), value);
        expect(() => verifyBuildIdentity(directory, identity)).toThrow();
      }
    });
  });

  it('rejects a symlink instead of following it to private filesystem data', () => {
    withDirectory((directory) => {
      const target = join(directory, 'fixture.json');
      writeFileSync(target, JSON.stringify({ format: 1, sha: identity.GITHUB_SHA, run_id: '42' }));
      symlinkSync(target, join(directory, 'ci-build-identity.json'));
      expect(() => verifyBuildIdentity(directory, identity)).toThrow();
    });
  });

  it.each([undefined, '', '0', '-1', '42,43', '42oops', ' 42', '1e3', '9007199254740992', 42])(
    'rejects an absent or ambiguous artifact ID (%s) instead of downloading every artifact',
    (value) => {
      expect(() => verifyBuildArtifactId(value)).toThrow();
    },
  );

  it('accepts exactly one immutable artifact ID and checks it before download', () => {
    expect(() => verifyBuildArtifactId('42')).not.toThrow();
    expect(command(['artifact-id'], { CI_BUILD_ARTIFACT_ID: '42' }).status).toBe(0);
    expect(command(['artifact-id'], { CI_BUILD_ARTIFACT_ID: '' }).status).toBe(1);
    withDirectory((directory) => {
      const write = command(['build-write', directory], identity);
      expect(write.status, write.stderr).toBe(0);
      const verify = command(['build-verify', directory], identity);
      expect(verify.status, verify.stderr).toBe(0);
      expect(verify.stdout).toBe('Same-run build revision verified.\n');
      const wrongRun = command(['build-verify', directory], { ...identity, GITHUB_RUN_ID: '43' });
      expect(wrongRun.status).toBe(1);
      expect(wrongRun.stdout).toBe('');
      expect(wrongRun.stderr).not.toContain(directory);
    });
  });
});

describe('parallel browser workflow retains the required release gate', () => {
  const unit = job('unit');
  const browser = job('browser');
  const aggregate = job('test');
  const profiles = Array.from(
    browser.matchAll(/^          - project: ([a-z-]+)\n            browser: ([a-z]+)$/gm),
    (match) => ({ project: match[1], browser: match[2] }),
  );
  const expectedProfiles = [
    { project: 'desktop', browser: 'chromium' },
    { project: 'mobile', browser: 'chromium' },
    { project: 'iphone-portrait', browser: 'webkit' },
    { project: 'iphone-landscape', browser: 'webkit' },
  ];

  it('keeps pull-request and main verification while removing duplicate branch-push runs', () => {
    expect(workflow).toMatch(
      /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:\n/m,
    );
    expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    expect(workflow).toContain(
      'group: jellyport-checks-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name != 'workflow_dispatch' }}",
    );
    expect(job('scope')).toContain(
      `if [ "$EVENT_NAME" = workflow_dispatch ]; then\n            echo 'docs_only=false' >> "$GITHUB_OUTPUT"`,
    );
    expect(job('scope')).toMatch(/^      - run: node scripts\/check-docs\.mjs$/m);
    expect(job('scope')).not.toMatch(/continue-on-error|\|\|\s*true|set\s+\+e/);
  });

  it('runs unit, build and audit once before saving an exact same-run build', () => {
    expect(unit).toContain('needs: scope\n');
    expect(unit).toContain(
      "if: needs.scope.result == 'success' && needs.scope.outputs.docs_only != 'true'\n",
    );
    expect(unit).toContain('ref: ${{ github.sha }}\n');
    expect(unit).toContain('node-version: 24\n');
    expect(unit).toContain('build_artifact_id: ${{ steps.build_artifact.outputs.artifact-id }}\n');
    const commands = [
      'run: npm ci\n',
      'run: npm test\n',
      'run: npm run build\n',
      'run: npm audit --omit=dev --audit-level=high\n',
      'run: node scripts/ci-runtime.mjs build-write dist\n',
      'name: Preserve the immutable verified build\n',
    ];
    const positions = commands.map((value) => unit.indexOf(value));
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(unit).toContain('name: browser-build-${{ github.sha }}-${{ github.run_attempt }}\n');
    expect(unit).toContain('if-no-files-found: error\n');
    expect(unit).not.toMatch(/continue-on-error|overwrite: true|\|\|\s*true|set\s+\+e/);
  });

  it('runs exactly the complete four profiles on independent VMs using that immutable build', () => {
    expect(profiles).toEqual(expectedProfiles);
    expect(browser).toContain('needs: [scope, unit]\n');
    expect(browser).toContain(
      "if: needs.scope.result == 'success' && needs.scope.outputs.docs_only != 'true'\n",
    );
    expect(browser).toContain('runs-on: ubuntu-latest\n');
    expect(browser).toContain('fail-fast: false\n');
    expect(browser).toContain('ref: ${{ github.sha }}\n');
    expect(browser).toContain('run: npx playwright install --with-deps ${{ matrix.browser }}\n');
    expect(browser).toContain('run: npm run test:e2e -- --project=${{ matrix.project }}\n');
    expect(browser).not.toMatch(
      /continue-on-error|--(?:grep|shard|retries|workers|fully-parallel)|\|\|\s*true|set\s+\+e/,
    );
    const guard = namedStep(browser, 'Require the exact immutable build artifact ID');
    const download = namedStep(browser, "Restore this run's exact verified build");
    const verify = namedStep(browser, 'Verify the build belongs to this run and revision');
    const run = namedStep(browser, 'Run every regression in this browser profile');
    expect(guard).toContain('CI_BUILD_ARTIFACT_ID: ${{ needs.unit.outputs.build_artifact_id }}\n');
    expect(guard).toContain('run: node scripts/ci-runtime.mjs artifact-id\n');
    expect(download).toContain(
      'uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
    );
    expect(download).toContain('artifact-ids: ${{ needs.unit.outputs.build_artifact_id }}\n');
    expect(download).toContain('path: dist/\n');
    expect(download).toContain('digest-mismatch: error\n');
    expect(download).not.toMatch(/^          (?:name|pattern|run-id|github-token|repository):/m);
    expect(verify).toContain('run: node scripts/ci-runtime.mjs build-verify dist\n');
    const ordered = [guard, download, verify, run].map((value) => steps(browser).indexOf(value));
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(browser).toContain(
      'name: browser-failures-${{ matrix.project }}-${{ github.run_attempt }}\n',
    );
  });

  it('keeps test (24) fail-closed and emits runtime success only after every dependency', () => {
    expect(aggregate).toContain('needs: [scope, unit, browser]\n');
    expect(aggregate).toContain('if: always()\n');
    expect(aggregate).toContain('node: [24]\n');
    expect(aggregate).not.toMatch(/^    name:/m);
    expect(aggregate).not.toMatch(/continue-on-error|\|\|\s*true|set\s+\+e/);
    const gate = namedStep(
      aggregate,
      'Require complete scope, unit, build, audit and browser results',
    );
    const runtime = namedStep(aggregate, 'Runtime checks passed');
    const docs = namedStep(aggregate, 'Documentation-only checks passed');
    expect(gate).toContain('CI_NEEDS: ${{ toJSON(needs) }}\n');
    expect(gate).toContain('run: node scripts/ci-runtime.mjs gate\n');
    expect(gate).not.toMatch(/if:|continue-on-error/);
    expect(runtime).toContain("if: needs.scope.outputs.docs_only != 'true'\n");
    expect(docs).toContain("if: needs.scope.outputs.docs_only == 'true'\n");
    for (const marker of [runtime, docs]) {
      expect(marker).not.toMatch(/always\(\)|continue-on-error/);
      expect(steps(aggregate).indexOf(marker)).toBeGreaterThan(steps(aggregate).indexOf(gate));
    }
  });

  it('proves the matrix selects every configured browser case exactly once with one worker', () => {
    type ListedSuite = {
      suites?: ListedSuite[];
      specs?: { id: string; tests: { projectName: string }[] }[];
    };
    type Inventory = {
      config: {
        workers: number;
        fullyParallel: boolean;
        projects: { name: string; retries: number; repeatEach: number }[];
        filteredProjects: { name: string; use: { browserName: string } }[];
      };
      suites: ListedSuite[];
    };
    function inventory(project?: string) {
      // --list imports the real test/config graph without starting a browser or server.
      const result = spawnSync(
        process.execPath,
        [
          join(root, 'node_modules/@playwright/test/cli.js'),
          'test',
          '--list',
          '--reporter=json',
          ...(project ? [`--project=${project}`] : []),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, CI: 'true' },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout) as Inventory;
      const cases: string[] = [];
      function visit(suite: ListedSuite) {
        for (const spec of suite.specs ?? [])
          for (const test of spec.tests) cases.push(`${test.projectName}:${spec.id}`);
        for (const child of suite.suites ?? []) visit(child);
      }
      for (const suite of value.suites) visit(suite);
      expect(cases.length).toBeGreaterThan(0);
      expect(new Set(cases).size).toBe(cases.length);
      return { ...value, cases };
    }
    expect(profiles).toEqual(expectedProfiles);
    const full = inventory();
    expect(full.config.workers).toBe(1);
    expect(full.config.fullyParallel).toBe(false);
    expect(full.config.projects.map((project) => project.name)).toEqual(
      expectedProfiles.map((profile) => profile.project),
    );
    expect(
      full.config.filteredProjects.map((project) => ({
        project: project.name,
        browser: project.use.browserName,
      })),
    ).toEqual(expectedProfiles);
    for (const project of full.config.projects) {
      expect(project.retries).toBe(0);
      expect(project.repeatEach).toBe(1);
    }
    const split = profiles.flatMap((profile) => {
      const selected = inventory(profile.project);
      expect(selected.cases.every((value) => value.startsWith(`${profile.project}:`))).toBe(true);
      return selected.cases;
    });
    expect(new Set(split).size).toBe(split.length);
    expect(split.sort()).toEqual(full.cases.sort());
  }, 30_000);
});
