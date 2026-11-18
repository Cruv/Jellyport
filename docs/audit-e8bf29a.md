# Audit follow-up for e8bf29a

The November 18, 2026 audit baseline was
`e8bf29a410fde736bd53c3b5a56e6b2e5f7c743d`. The implementation and benchmark
revision was `c21141d6da32a32bff474fb90464541775a6f4aa`. Local checks ran on Node
v24.22.1 on macOS ARM64 with isolated SQLite directories, fake media servers,
and injected Discord and Stripe fixtures.

## Acceptance regressions

| Item | Reproduction and result |
| --- | --- |
| 1. Migration source and follow-up | `npm test -- tests-ts/app.test.ts tests-ts/migration-workload-service.test.ts tests-ts/service.test.ts frontend/src/App.test.tsx`. The baseline accepted a same-URL Emby replacement, ran unpinned queued work, and lost the original follow-up scope on refresh. The current fixtures reject source replacements at approval, restart, and the write boundary, preserve watched-only scope and the original job, and stop mapped recovery from reading history before a fresh migration review. |
| 2. Stripe tier impact and evidence | `npm test -- tests-ts/stripe-http.test.ts tests-ts/stripe-integration.test.ts tests-ts/membership-http.test.ts frontend/src/StripeIntegrationPanel.test.tsx`. The baseline accepted an ordinary downgrade save and discarded the first owner's proof as the cursor advanced. The new tests reject unapproved and stale remaps, disable only still-matching reviewed slots, and preserve first-owner evidence after a 25-owner/26-invoice first pass and a 2-owner/2-invoice resumed pass. Timeline tests retain invoice history after a current link or authority changes. |
| 3. Offline WAL | `npm test -- tests-ts/backup-verification.test.ts`. All seven damaged WAL variants were accepted over a sound base on the baseline. The verifier rejects every damaged copy, accepts the retained WAL with newer committed settings, checks replay against the frame count, and preserves byte equality. A receipt proves completeness through the supplied last commit. Detecting an omitted WAL or whole committed suffix requires independent backup metadata. [Offline verification](docker-deployment.md#verify-a-jellyport-backup-offline) |
| 4. Activity and readiness | `npm test -- frontend/src/App.test.tsx -t 'binds Activity actions|refreshes the Emby roster in place'`. Both regressions failed on the baseline. Loading, failed, and late responses can no longer expose actions for a different Activity query, status, or page. Successful requirements retry refreshes the roster in place, retaining selected IDs on read failure. |
| 5. Inbox | `npm test -- tests-ts/job-history-http.test.ts -t 'reports missing imports'`. The baseline omitted at least one required item. An import without a usable catalog now needs attention and shows relevant dates. An old uncertain delivery remains visible with unlimited retention, and the claimant and another administrator session see different reveal availability without seeing credential material. |
| 6. Submission recovery and polling | `npm test -- tests-ts/app.test.ts tests-ts/job-history-http.test.ts frontend/src/App.test.tsx`. Concurrent and repeated creation submissions recover the original ID; altered bodies are rejected. The poll test discovers external work while idle, aborts a hung response, and recovers. Revocation returns 401. The browser account flow drops the successful creation response and finds the original job by receipt after reload. |
| 7. Discord and migration locks | `npm test -- tests-ts/discord-reconciliation.test.ts tests-ts/bot.test.ts tests-ts/user-organization.test.ts tests-ts/migration-workload-service.test.ts`. Bounded passes cover all 80 tracked owners in batches of 32, 32 and 16, and organization upkeep advances during a stalled membership pass. A stalled Jellyfin capability lookup blocked unrelated access for 1,529 ms on the baseline, crossing the 1,500 ms deadline. The same regression completed in 27 ms with the fix. |

The complete local suite passed 4,095 tests. The focused production-build browser
run passed eight desktop and iPhone portrait cases across account receipt and
credential recovery, migration receipts, and Stripe administration. The
production npm audit reported zero vulnerabilities.

## Before and after measurements

The same scripts ran on Node v24.22.1 with the same fixtures against the audit
baseline and implementation. To reproduce the baseline, archive `e8bf29a` into
an isolated checkout, copy the benchmark script from the implementation, and
install or link the repository dependencies. Retain the baseline Git revision
for the operation status benchmark. Run each command in both checkouts.

```sh
node --import tsx scripts/benchmark-operation-status.ts
node --import tsx scripts/benchmark-discord-reconciliation.ts
```

| Synthetic fixture | Baseline | Implementation |
| --- | ---: | ---: |
| 60 seconds idle, empty operation feed | 20 polls, 1,680 payload bytes, 20 public server identity reads, 20 administrator reads | 3 polls, 252 payload bytes, 3 public server identity reads, 3 administrator reads |
| 60 seconds active, one running operation | 20 polls, 10,520 payload bytes, 40 upstream authentication reads | 20 polls, 10,520 payload bytes, 40 upstream authentication reads |
| Authenticated local processing of the idle schedule | 4.347 ms | 1.332 ms |
| Authenticated local processing of the active schedule | 3.056 ms | 4.058 ms |
| Discord pass with 40 link-only owners, 40 membership-only owners, and a 2,500-member roster | 80 exact owner reads plus 3 roster reads covering 2,500 rows, 16.384 ms | 32 exact owner reads plus 1 roster read covering 50 rows, 4.293 ms |

Status polling has an eight-second browser deadline and retains both Jellyfin
identity checks per completed request. Its 20-second idle and three-second
active cadences are measured as simulated schedules with real authenticated
route handling and injected HTTP responses. Local milliseconds exclude waiting
between polls and do not estimate production response time. Discord figures
measure a single scheduled pass. Subsequent passes rotate through the remaining
owners.
