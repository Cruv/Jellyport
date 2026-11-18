# November 18, 2026 audit follow-up

Audit baseline `d45bf1710e3f85e34cada55fd454197112106baa`. The implementation
benchmarked here is `49bbce580a8b6674ab1fa389d6b07b8edc1f7e4c`.
Fixtures contain synthetic accounts and item data. No production media server,
billing account, backup, or operating volume was used.

## Reproduce the checks

Use Node 24 and `npm ci`. Run `npm test`, `npm run build`, `npm run docs:check`,
`npm audit --omit=dev --audit-level=high`, and `npm run test:e2e` with Chromium and
WebKit installed. The desktop and phone tests use isolated demo or writable
synthetic servers. The [delivery procedure](development.md#merge-and-publication-gates)
describes the required pull request, exact-main, and image checks.

| Item | Targeted evidence |
| --- | --- |
| 1. Reviewed destination | `npm test -- tests-ts/app.test.ts tests-ts/manual-migration-slots-http.test.ts tests-ts/protected-history-migration.test.ts tests-ts/migration-workload-service.test.ts tests-ts/offline-destination-service.test.ts`. The reviewed-absence and same-name replacement regressions both returned 202 on the baseline and 400 with the fix. Queued work verifies identity, the pinned catalog generation, and absence before provisioning. |
| 2. Discord authority | `npm test -- tests-ts/membership-http.test.ts tests-ts/membership-races.test.ts tests-ts/family-access.test.ts tests-ts/subscriber-role-exemptions.test.ts frontend/src/SettingsPage.test.tsx`. Covers guild and role cutover, legacy links, exact owner and account review, unchanged access, and a race after operation start. |
| 3. Deferred Stripe expiry | `npm test -- tests-ts/stripe-entitlements.test.ts tests-ts/stripe-service-automation.test.ts tests-ts/stripe-http.test.ts`. Covers defer, enable, revalidation, restart, repeat evidence, and the difference between a deferred decision and a previously attempted write. Provider fixtures use synthetic HTTP. |
| 4. One-time credentials | `npm test -- tests-ts/app.test.ts tests-ts/store.test.ts tests-ts/bot-message-history.test.ts frontend/src/App.test.tsx`. `e2e/account-flows.spec.ts` delays a real synthetic API response, drops it, reloads, recovers in the same session, consumes the receipt, and verifies it cannot be reused. Other sessions, expired receipts, and credential-bearing report archives are covered by the API tests. |
| 5. Settings revisions | `npm test -- tests-ts/app.test.ts frontend/src/SettingsPage.test.tsx`. `e2e/media-admin-settings-concurrency.spec.ts` uses two browser tabs on the same writable fixture to prove independent saves merge and same-field conflicts retain the second draft. |
| 6. Readiness and recovery | `npm test -- tests-ts/workflow-readiness.test.ts tests-ts/destination-catalogs.test.ts tests-ts/new-subscriber-policy-service.test.ts tests-ts/subscription-source-races.test.ts tests-ts/store.test.ts frontend/src/App.test.tsx`. Browser journeys include version-incompatible import repair, cancellation and Activity. |
| 7. Activity polling | `npm test -- tests-ts/job-history-http.test.ts tests-ts/job-history-cleanup.test.ts tests-ts/job-retention.test.ts`. Covers bounded responses, private diagnostics only on demand, filter counts and cleanup, and cached Overview probes. Legacy summary backfill projects fields inside SQLite. |
| 8. Mutation lock | `npm test -- tests-ts/migration-workload-service.test.ts -t 'completes unrelated access'`. The same three-account, three-item fixture stalls source history, destination state, and independent readback separately. Each baseline case blocked unrelated access at the 1,500 ms deadline. All three passed on the final implementation in 588 ms total. |
| 9. Directory and reconciliation | `npm test -- tests-ts/user-organization.test.ts tests-ts/stripe-integration.test.ts tests-ts/stripe-role-cleanup-integration.test.ts`. One-owner role work used zero roster reads, one exact Discord member read and two media account reads. The bounded Stripe fixture used 26 invoice reads across 25 households in the first round, then two reads for the remaining two after restart. The linked-customer fixture verifies all evidence before an access action. |
| 10. Verification tools and dependencies | `npm run benchmark:destination`, `npm ls @fastify/static glob minimatch`, and the production advisory command above. The baseline had three moderate findings. The final lockfile resolves `@fastify/static@10.1.11` → `glob@14.0.6` → `minimatch@11.0.9` with zero reported production vulnerabilities. |
| 11. Operations inbox | `npm test -- tests-ts/job-history-http.test.ts tests-ts/backup-verification.test.ts` and the Overview layout in all browser profiles. The inbox links saved history, Discord authority, identity, billing, event, and account recovery issues to the corresponding workspace. |
| 12. Household timeline | `npm test -- tests-ts/membership-http.test.ts tests-ts/stripe-integration.test.ts frontend/src/MembershipsPage.test.tsx`. The paid downgrade/reactivation journey in `e2e/media-admin-workflows.spec.ts` checks declared slots, preserved exact account identities, and the linked operation. |
| 13. Tray, receipts and retry | `npm test -- tests-ts/app.test.ts tests-ts/job-history-http.test.ts frontend/src/App.test.tsx`. `e2e/media-admin-household-migration.spec.ts` drops an accepted migration response, reloads the tab, and recovers the exact original job through the tray without a second submission. The API rejects altered replays and changed Emby authority, and excludes successful source IDs from a fresh retry. |
| 14. Offline backup verification | `npm test -- tests-ts/backup-verification.test.ts`. The fixture covers a retained WAL, matching and wrong keys, file integrity, a tamper-resistant external receipt, and byte equality for the operating and backup files. See the [offline command](docker-deployment.md#verify-a-jellyport-backup-offline). |

## Synthetic performance comparison

On November 18, 2026, Node v24.22.1 on macOS ARM64 ran the same benchmark files
against both revisions. To reproduce, extract the baseline with
`git archive d45bf17` into an isolated checkout, copy
`scripts/benchmark-operations.ts` and `scripts/benchmark-destination.ts` from the
implementation revision, and install or link the locked dependencies needed by
the synthetic scripts. Retain the baseline Git HEAD so the operations benchmark
reports that revision. Run these commands in both checkouts.

```sh
node --import tsx scripts/benchmark-operations.ts
npm run benchmark:destination
```

| Measurement | Fixture and scope | Baseline | Implementation |
| --- | --- | ---: | ---: |
| Response bytes per progress poll | 1,000 reports with 120 diagnostic items each. Final feed includes three active and six recent operations. | 22,966,790 | 2,464 |
| Synchronous time per poll | Mean of five SQLite reads, JavaScript processing, and JSON serialization passes | 79.403 ms | 0.072 ms |
| Directory assembly | 4,000 confirmed owners and 8,000 Emby/Jellyfin accounts. In-memory provider adapters. | 297.802 ms | 10.915 ms |
| Owner event lookups for reconciliation | 100 owner lookups over 20,000 stored events. Each owner matches five events. | 1,992.898 ms | 1.749 ms |
| Destination request counts | 100,000 items, 100 users, 200 candidates each. Half have imported membership metadata and half use live catalog metadata. | 1,001 catalog, 100 policy, 100 library configuration, 10,000 individual probes, 200 state | 1,001 catalog, 100 policy, 100 library configuration, 10,000 individual probes, 200 state |
| Destination synthetic runtime | Same injected transport, cache, matching, access checks and newer-history preservation | 7,355.1 ms | 6,531.5 ms |

The destination benchmark repairs the model for both revisions. It asserts a
maximum 170 IDs and 6,000 URL-encoded ID characters per state request, and makes
zero proposed changes to newer Jellyfin activity. Its request counts do not
measure playback pacing or remote response time. Directory and reconciliation
measure local processing. The Stripe fixture measures invoice reads separately
from access action timing.
