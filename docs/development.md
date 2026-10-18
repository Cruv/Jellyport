# Development and delivery

This is the canonical development procedure. [AGENTS.md](../AGENTS.md) owns the
project boundaries, owner preferences and task routing. User documentation starts
in [README.md](../README.md); detailed operational procedures stay in their linked
guides. There are no additional repository-local AI-client instructions or skills.

## Start and choose scope

Check `git status --short`, the current revision and relevant recent commits before
editing. Identify owned and foreign changes. Inspect affected entrypoints and
complete functions as needed; search for relevant sections rather than loading
every guide. Implementation establishes behavior, while owner instructions and
documented safeguards establish policy. Preserve an ambiguous material safeguard
and record the specific uncertainty instead of silently removing it.

| Area                       | Entrypoints and useful references                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| API and lifecycle          | `server/index.ts`, `server/main.ts`, `server/startup.ts`, `server/service.ts`                                               |
| Interface                  | `frontend/src/main.tsx`, `frontend/src/App.tsx`, affected page and component tests                                          |
| History and identity       | `server/migration.ts`, `server/matching.ts`, `server/media.ts`, [capabilities](migration-capabilities.md)                   |
| Saved history              | `server/source-snapshots.ts`, `server/snapshot-helper.ts`, relevant reader/importer, [plugin guide](emby-plugin-backups.md) |
| Authentication and storage | `server/jellyfin-auth.ts`, `server/security.ts`, `server/store.ts`, [security review](security-review.md)                   |
| Delivery                   | `Dockerfile`, Compose examples, `.github/workflows/ci.yml`, `.github/workflows/docker-publish.yml`                          |

Keep one source for each procedure. README can summarize and link; other AI clients
should use AGENTS as their adapter target. Do not create skills, client files or
review layers without a concrete need. Unrelated feature ideas belong in the
existing [automation backlog](../README.md#planned-automation-improvements), not in
the current task's acceptance conditions.

## Commands and isolated development

Use Node 24, or a supported Node 22 release as specified by `package.json`, and
install the lockfile with `npm ci`.
The workflow regression tests also use Git, Bash and `jq`, as available on the
GitHub Ubuntu runners; install those tools before running that corpus locally.

For a synthetic local demo:

```sh
JELLYPORT_DEMO=true JELLYPORT_DATA_DIR=/tmp/jellyport-demo \
JELLYPORT_SECURE_COOKIE=false HOST=127.0.0.1 npm run dev
```

In a second terminal run `npm run dev:ui` and open `http://127.0.0.1:5173`.
The demo sign-in is `admin` / `demo-jellyport`; its simulated media servers reset
on restart and its settings are read-only. Choose a separate, unused data
directory. Demo startup refuses production data. Vite proxies `/api` to port 8000.

| Command                                   | Scope                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run docs:check`                      | Repository Markdown links, local paths and heading anchors; no remote requests                   |
| `npm test -- tests-ts/matching.test.ts`   | Example focused Vitest run; substitute affected files                                            |
| `npm test`                                | Complete backend and React test corpus                                                           |
| `npm run test:e2e`                        | Typechecked desktop/mobile browser regressions against the current production build; build first |
| `npm run typecheck`                       | Backend and frontend types without building                                                      |
| `npm run build`                           | Typecheck, compile server and build production interface; do not also typecheck unchanged inputs |
| `HOST=127.0.0.1 npm start`                | Run an existing build; use the demo environment above for isolated checks                        |
| `npm audit --omit=dev --audit-level=high` | Current production dependency advisory check                                                     |
| `npm run benchmark:snapshots`             | Optional synthetic-only benchmark; accepts no production paths or URLs                           |

`npm run format` rewrites many code/config files. For a narrow edit use
`npx prettier --check <owned-files>` or `--write` on those files only; do not
reformat unrelated Markdown tables or foreign work. Finish owned changes with
`git diff --check` and a scope review.

### Automated interface regressions

`npm test` includes behavioral unit/component regressions for navigation, filtered
selections, stale recovery responses, independent saves, cancelled confirmations,
and failed-save retries. The required Node 24 CI job also runs Chromium and WebKit
browser tests after building the app. A browser failure fails that required job
and prevents image publication. Node 22 continues to run the full unit/component
suite and production build.

To run the browser suite locally:

```sh
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

The [Playwright suite](https://playwright.dev/docs/intro) checks all ten workspace
pages at desktop and mobile widths, document overflow, focused Settings tabs,
retained drafts, keyboard focus, pagination and filtering with large synthetic
directories, page/tab restoration after reload and browser Back/Forward,
sign-in/out, credential reveal, explicit migration approval, and reviewed
single/bulk activity deletion. Bookmark tests check that private fields are not
serialized and that returning to a view never replays an action.
It uses the built interface and real Jellyport API with simulated media servers. These are behavioral and layout checks, not pixel-baseline comparisons
or a guarantee of support for every browser.

iPhone coverage uses Playwright's iPhone 16 Pro Max touch/mobile WebKit profiles:
the portrait screen is 440 × 956 CSS pixels with a 440 × 763 browser viewport,
and the landscape viewport is 838 × 390. The profile models browser space rather
than treating the entire phone screen as page content. Tests cover touch targets,
form sizing, navigation, key admin flows, orientation changes and reduced visible
height. Safe-area and keyboard-height simulations exercise layout behavior;
native iOS browser chrome and the software keyboard still require a physical
device check when investigating device-specific behavior.

The runner creates and removes its own temporary demo data, binds only to
`127.0.0.1:4179`, refuses to reuse an existing server, and ignores Jellyport
environment variables and `.env`. It accepts no production URL or backup path.
Browser requests outside that local origin fail the test. Each test has a fresh
browser context; synthetic session cookies remain in memory. No real users,
credentials, backups, media servers, or Discord messages are used.

Failures save synthetic-only screenshots and traces in ignored `test-results/`;
CI retains that evidence for seven days. Open a trace with
`npx playwright show-trace <trace.zip>`. Retries are disabled so an intermittent
failure stays visible. Fix the behavior or test synchronization rather than
relaxing safeguards or accepting a failed run.

## Verification proportional to risk

| Change                                              | Sufficient local evidence before delivery                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation or instructions only                  | Documentation check, affected links/paths/commands and routing, diff review. Exercise changed procedures against relevant scenarios. No product version, application build, benchmark, tag or deployment is needed.                            |
| Local behavior fix                                  | Regression reproducing the failure and affected tests; typecheck for TypeScript changes. Broaden when shared dependencies or failures justify it.                                                                                              |
| UI                                                  | Affected component/flow tests and typecheck. Inspect an owned local demo for visible interaction/layout changes; build when production bundling, entrypoints or assets are affected.                                                           |
| Shared matching, parser or history logic            | Complete affected fixture corpus, supported schema/version variants and adverse cases: ambiguous identity, malformed/oversized input, newer destination activity, reruns and cancellation as applicable.                                       |
| Persistence, authentication, security or public API | Complete affected compatibility/security corpus and meaningful adverse cases, plus the full suite and production build. Include upgrades, authorization/CSRF, safe errors, secret handling and crash/uncertain-operation cases where affected. |
| Containers or release workflows                     | Affected classifier/workflow checks, Compose validation and owned local container smoke when execution changes; preserve the full runtime CI and publisher gates below.                                                                        |

Fixtures must be synthetic. Authorized real-backup inspection uses private local
copies and fake destinations; never commit the data or silently turn it into a
production migration. [Workload safety](performance-safety.md) explains the live
source limits and the distinct authorization needed for production trials.

## Reuse evidence and bound review

Record a check's date, revision, command, relevant inputs and result. Reuse it while
the affected implementation, tests/fixtures, source data, configuration and runtime
environment still apply. Documentation edits do not invalidate unchanged parser
tests; parser changes invalidate their prior results. Lockfile/Node/platform changes
invalidate corresponding dependency/runtime evidence. Fresh advisory checks and
remote CI/publisher results have their own scope and time; a local pass does not
complete a pending remote check. Preserve original dates and benchmark limitations.
Never weaken assertions, refresh reviewed-input hashes or relabel old evidence to
make a check appear current.

Use independent review when it adds evidence, especially for security, data loss
or release gates. One scoped pass is normally enough; another reviewer, refutation
exercise or wider audit needs a specific unresolved risk or failure. Close findings
by fixing and verifying them or recording a bounded blocker. After a failed tool
attempt, try one justified retry or supported fallback, then report the remaining
limitation and continue independent work. Never bypass a protection to finish.

Work is complete when the cohesive outcome is implemented, affected contradictions
are resolved, sufficient checks pass, and remaining limitations are explicit.
Report unrelated findings without expanding the task into an open-ended audit.

## Merge and publication gates

Follow the commit/push/squash-merge preference in [AGENTS.md](../AGENTS.md). Stage
only owned paths. One cohesive outcome is one delivery boundary; do not require a
commit, product version, tag or release for every subtask. Product version changes
belong to intentional runtime releases, with `package.json` and its lockfile kept
consistent. No semantic image tags, Git tags or GitHub Releases are currently
automated; the owner has not established a separate release cadence.

The workflows define the executable gates:

- Documentation-only changes run documentation validation. The required
  `test (22)`, `test (24)` and `docker` checks remain present and cannot pass if
  that validation fails; they skip application work only for the explicit docs
  allowlist. Any code, script, configuration or workflow change gets full checks.
  Keep `docs/` assets exclusive to documentation; if runtime code begins consuming
  them, change the classifier and its tests before relying on this exemption.
- Runtime verification covers Node 22/24, the full suite, production builds and
  dependency audit, Compose examples, and demo/setup/secure-cookie/unprivileged
  container smoke. `Checks` manual dispatch always runs full verification.
- Automatic publication requires a successful same-repository main-push check
  run for the exact current main commit **with full runtime verification**.
  Documentation-only validation cannot authorize an image. Manual publication
  requires full successful Checks for that exact main revision too.
- Native AMD64 and ARM64 candidates are tested by digest. Both tested digests
  must pass before promotion to `latest` and `sha-<full-commit-sha>`; do not rebuild
  between testing and promotion or replace a tested digest with a mutable tag.

These gates prevent stale revisions, unverified runtime changes and untested image
promotion. They do not authorize production deployment, load tests, migration
trials or media-server restarts; the separate boundary remains in AGENTS. A blocked
check or publication remains a blocker, never a completed release.

## Resume without rereading everything

For a long task or handoff, keep one small local `.codex/checkpoint.md` (ignored by
Git). Replace its current state instead of appending a diary. Include:

- Scope, branch and revision; owned/foreign edits and paused work.
- Completed checks with dates, inputs and results; pending or invalidated evidence.
- Specific unresolved issues, live process/tool/agent handles, and the next action.

On resumption read AGENTS and that checkpoint, verify working-tree/revision/handle
state, and reopen only the references relevant to the next action. Reconcile newer
owner instructions before continuing. Keep detailed historical evidence in Git,
the dated reviews and linked performance records; do not require their full reread.
