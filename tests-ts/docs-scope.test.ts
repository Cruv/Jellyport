import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const { isDocsOnly, docsOnlyDiff } = (await import(
  new URL('../scripts/docs-scope.mjs', import.meta.url).href
)) as {
  isDocsOnly(paths: unknown): boolean;
  docsOnlyDiff(base: string, head: string, cwd?: string): boolean;
};

describe('documentation-only workflow scope', () => {
  it('accepts only nonempty explicitly allowed prose and documentation assets', () => {
    expect(
      isDocsOnly([
        'AGENTS.md',
        'README.md',
        'SECURITY.md',
        'CLAUDE.md',
        'GEMINI.md',
        'docs/development.md',
        'docs/references/guide.md',
        'docs/image with spaces.png',
        'docs/diagram.svg',
      ]),
    ).toBe(true);
    expect(isDocsOnly([])).toBe(false);
    expect(isDocsOnly(undefined)).toBe(false);
    expect(isDocsOnly('README.md')).toBe(false);
  });

  it.each([
    'server/media.ts',
    'frontend/src/App.tsx',
    'tests-ts/media.test.ts',
    'scripts/check-docs.mjs',
    'scripts/browser-demo.mjs',
    '.github/workflows/ci.yml',
    'playwright.config.ts',
    'e2e/workspace.spec.ts',
    'e2e/fixtures.ts',
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'compose.yaml',
    'examples/compose.portainer.yaml',
    '.env.example',
    'CONTRIBUTING.md',
    'README.txt',
    'LICENSE',
    'docs/script.js',
    'docs/config.yaml',
    'docs/example.html',
    'docs/archive.zip',
    'docs/../server/media.ts',
    'docs//guide.md',
    './README.md',
    '/README.md',
    'docs/./guide.md',
    'docs\\guide.md',
    'docs/line\nbreak.md',
  ])('requires runtime validation when %s changes', (path) => {
    expect(isDocsOnly(['README.md', path])).toBe(false);
  });

  it('includes runtime deletion when a file is renamed into the docs allowlist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-docs-scope-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const commit = (message: string) => {
      git('add', '--all');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        message,
      );
      return git('rev-parse', 'HEAD').trim();
    };
    try {
      git('init', '-q');
      mkdirSync(join(directory, 'server'));
      mkdirSync(join(directory, 'docs'));
      writeFileSync(join(directory, 'server', 'original.ts'), 'Synthetic runtime file.\n');
      writeFileSync(join(directory, 'README.md'), '# Synthetic\n');
      const base = commit('initial');
      writeFileSync(join(directory, 'docs', 'guide.md'), '# Guide\n');
      const docs = commit('docs');
      expect(docsOnlyDiff(base, docs, directory)).toBe(true);
      expect(docsOnlyDiff(docs, docs, directory)).toBe(false);
      renameSync(join(directory, 'server', 'original.ts'), join(directory, 'docs', 'moved.md'));
      const renamed = commit('runtime renamed into docs');
      expect(docsOnlyDiff(docs, renamed, directory)).toBe(false);
      expect(docsOnlyDiff(base, renamed, directory)).toBe(false);
      expect(docsOnlyDiff('0'.repeat(40), renamed, directory)).toBe(false);
      expect(docsOnlyDiff('--help', renamed, directory)).toBe(false);
      expect(docsOnlyDiff(base, renamed, join(directory, 'absent'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('browser regression checks gate the required runtime job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const testJob = workflow.match(/\n  test:\n([\s\S]*?)\n  docker:/)?.[1];
  if (!testJob) throw new Error('Required runtime test job must be present.');
  const steps = testJob.split(/^      - /m).slice(1);

  function namedStep(name: string) {
    const matching = steps.filter((step) => step.startsWith(`name: ${name}\n`));
    expect(matching, `${name} must occur exactly once in the required test job`).toHaveLength(1);
    return matching[0];
  }

  it('runs Chromium interface checks on Node 24 after the build and before the success marker', () => {
    expect(testJob).toContain('node: [22, 24]');
    const install = namedStep('Install browser for interface regression tests');
    const browser = namedStep('Run desktop and mobile interface regression tests');
    const marker = namedStep('Runtime checks passed');
    expect(install).toContain('        run: npx playwright install --with-deps chromium\n');
    expect(browser).toContain('        run: npm run test:e2e\n');
    for (const step of [install, browser]) {
      expect(step).toContain(
        "        if: needs.scope.outputs.docs_only != 'true' && matrix.node == 24\n",
      );
      expect(step).not.toMatch(/continue-on-error|\|\|\s*true|always\(\)|set\s+\+e/);
    }
    expect(marker).toContain("        if: needs.scope.outputs.docs_only != 'true'\n");
    expect(marker).not.toMatch(/continue-on-error|always\(\)/);
    const buildIndex = steps.findIndex((step) => step.startsWith('run: npm run build\n'));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(install)).toBeGreaterThan(buildIndex);
    expect(steps.indexOf(browser)).toBeGreaterThan(steps.indexOf(install));
    expect(steps.indexOf(marker)).toBeGreaterThan(steps.indexOf(browser));
  });
});

describe('image publication requires actual runtime validation', () => {
  const sha = 'a'.repeat(40);
  const repository = 'Fixture/Jellyport';
  const run = {
    id: 42,
    head_sha: sha,
    head_branch: 'main',
    head_repository: { full_name: repository },
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = [
    { name: 'test (22)', marker: 'Runtime checks passed' },
    { name: 'test (24)', marker: 'Runtime checks passed' },
    { name: 'docker', marker: 'Runtime Docker checks passed' },
  ].map(({ name, marker }) => ({
    name,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    steps: [{ name: marker, conclusion: 'success' }],
  }));
  const docsJobs = jobs.map((job) => ({
    ...job,
    steps: [
      { name: job.steps[0].name, conclusion: 'skipped' },
      { name: 'Documentation-only checks passed', conclusion: 'success' },
    ],
  }));
  const workflow = readFileSync(
    new URL('../.github/workflows/docker-publish.yml', import.meta.url),
    'utf8',
  );
  const body = workflow.match(/        run: \|\n([\s\S]*?)\n\n  build:/)?.[1];
  if (!body) throw new Error('Publisher verification script must be present.');
  const script = body.replace(/^          /gm, '');

  function verify({
    event = 'workflow_run',
    main = sha,
    runs = [run],
    checkedJobs = jobs,
  }: {
    event?: string;
    main?: string;
    runs?: (typeof run)[];
    checkedJobs?: typeof jobs;
  } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'jellyport-publish-gate-'));
    const output = join(directory, 'output');
    writeFileSync(output, '');
    try {
      // Execute the real workflow shell against fixed local API responses.
      // This function replaces gh; no GitHub, registry or media request occurs.
      const result = spawnSync(
        'bash',
        [
          '-c',
          `gh() {
            case "$*" in
              *git/ref/heads/main*) printf '%s\\n' "$MOCK_MAIN" ;;
              *actions/workflows/ci.yml/runs*) printf '%s\\n' "$MOCK_RUNS" ;;
              *actions/runs/*/jobs*) printf '%s\\n' "$MOCK_JOBS" ;;
              *) return 99 ;;
            esac
          }
          ${script}`,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            SOURCE_SHA: sha,
            SOURCE_RUN_ID: '42',
            EVENT_NAME: event,
            GITHUB_REPOSITORY: repository,
            GITHUB_OUTPUT: output,
            MOCK_MAIN: main,
            MOCK_RUNS: JSON.stringify({ workflow_runs: runs }),
            MOCK_JOBS: JSON.stringify([{ jobs: checkedJobs }]),
          },
        },
      );
      return {
        status: result.status,
        log: result.stdout + result.stderr,
        output: readFileSync(output, 'utf8'),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('accepts exact current main with all three successful runtime markers', () => {
    const result = verify();
    expect(result.status, result.log).toBe(0);
    expect(result.output).toContain(`sha=${sha}\n`);
    expect(result.output).toContain('image=ghcr.io/fixture/jellyport\n');
    expect(result.output).toContain('publish=true\n');
  });

  it('skips automatic publication after docs-only successful jobs', () => {
    const result = verify({ checkedJobs: docsJobs });
    expect(result.status, result.log).toBe(0);
    expect(result.output).toBe('publish=false\n');
  });

  it('refuses manual publication with only documentation check evidence', () => {
    const result = verify({
      event: 'workflow_dispatch',
      checkedJobs: docsJobs,
    });
    expect(result.status).toBe(1);
    expect(result.output).toBe('');
    expect(result.log).toContain('Run Checks manually on current main');
  });

  it('accepts forced-full manual Checks for manual publication of exact main', () => {
    const result = verify({
      event: 'workflow_dispatch',
      runs: [{ ...run, event: 'workflow_dispatch' }],
    });
    expect(result.status, result.log).toBe(0);
    expect(result.output).toContain('publish=true\n');
  });

  it.each([
    { ...run, head_sha: 'b'.repeat(40) },
    { ...run, head_branch: 'other' },
    { ...run, head_repository: { full_name: 'Foreign/Fork' } },
    { ...run, event: 'pull_request' },
    { ...run, conclusion: 'failure' },
    { ...run, status: 'in_progress' },
    { ...run, id: 43 },
  ])('rejects incompatible or unrelated Checks run %j', (incompatible) => {
    const result = verify({ runs: [incompatible] });
    expect(result.status).toBe(1);
    expect(result.output).toBe('');
  });

  it('rejects publication after main moved, even when earlier checks passed', () => {
    const result = verify({ main: 'b'.repeat(40) });
    expect(result.status).toBe(1);
    expect(result.log).toContain('Only the current main commit');
    expect(result.output).toBe('');
  });

  it.each(['workflow_run', 'workflow_dispatch'])(
    'rejects %s publication after browser checks fail in the required Node 24 job',
    (event) => {
      const checkedJobs = structuredClone(jobs);
      checkedJobs[1].conclusion = 'failure';
      checkedJobs[1].steps.push({
        name: 'Run desktop and mobile interface regression tests',
        conclusion: 'failure',
      });
      // A successful marker cannot override the required job's failure.
      const result = verify({ event, checkedJobs });
      expect(result.status).toBe(1);
      expect(result.output).toBe('');
    },
  );

  it.each([
    'missing-marker',
    'failed-marker',
    'missing-arm-runtime',
    'skipped-job',
    'wrong-job-sha',
    'duplicate-job',
    'failed-duplicate-job',
  ])('%s cannot stand in for complete runtime checks', (scenario) => {
    const checkedJobs = structuredClone(jobs);
    if (scenario === 'missing-marker') checkedJobs[0].steps = [];
    if (scenario === 'failed-marker') checkedJobs[0].steps[0].conclusion = 'failure';
    if (scenario === 'missing-arm-runtime') checkedJobs.splice(1, 1);
    if (scenario === 'skipped-job') checkedJobs[0].conclusion = 'skipped';
    if (scenario === 'wrong-job-sha') checkedJobs[0].head_sha = 'b'.repeat(40);
    if (scenario === 'duplicate-job') checkedJobs.push(checkedJobs[0]);
    if (scenario === 'failed-duplicate-job')
      checkedJobs.push({ ...checkedJobs[0], conclusion: 'failure' });
    for (const event of ['workflow_run', 'workflow_dispatch']) {
      const result = verify({ event, checkedJobs });
      expect(result.status).toBe(1);
      expect(result.output).toBe('');
    }
  });

  it.each([
    'missing-doc-marker',
    'failed-doc-marker',
    'missing-job',
    'skipped-job',
    'failed-job',
    'wrong-job-sha',
    'duplicate-job',
    'failed-duplicate-job',
    'mixed-runtime-and-docs',
    'failed-runtime-with-doc-marker',
  ])('does not silently skip automatic publication with %s', (scenario) => {
    const checkedJobs = structuredClone(docsJobs);
    if (scenario === 'missing-doc-marker') checkedJobs[0].steps = [];
    if (scenario === 'failed-doc-marker') checkedJobs[0].steps[1].conclusion = 'failure';
    if (scenario === 'missing-job') checkedJobs.splice(1, 1);
    if (scenario === 'skipped-job') checkedJobs[0].conclusion = 'skipped';
    if (scenario === 'failed-job') checkedJobs[0].conclusion = 'failure';
    if (scenario === 'wrong-job-sha') checkedJobs[0].head_sha = 'b'.repeat(40);
    if (scenario === 'duplicate-job') checkedJobs.push(checkedJobs[0]);
    if (scenario === 'failed-duplicate-job')
      checkedJobs.push({ ...checkedJobs[0], conclusion: 'failure' });
    if (scenario === 'mixed-runtime-and-docs') checkedJobs[0].steps[0].conclusion = 'success';
    if (scenario === 'failed-runtime-with-doc-marker')
      checkedJobs[0].steps[0].conclusion = 'failure';
    const result = verify({ checkedJobs });
    expect(result.status).toBe(1);
    expect(result.output).toBe('');
    expect(result.log).toContain(
      'did not provide complete runtime or documentation-only validation evidence',
    );
  });
});
