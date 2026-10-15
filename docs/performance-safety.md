# Migration workload and playback safety

## Incident evidence and limits of attribution

On October 8, 2026, the installed Jellyport revision
`5f412a8d5292f27320a2d024adaf38b6314e7179` performed a migration while approximately
22–23 Emby playback sessions continued. The source was Emby 4.10.1.0; the reported
destination was Jellyfin 12.2.0.

Emby logged a per-user recursive catalog request with `StartIndex=83500`,
`Limit=500`, `SortBy=SortName`, `EnableUserData=true`, playback count/date fields,
and `EnableTotalRecordCount=true`. That request took 2,182 ms. Its shape matches
the old `itemsByType()` / `migrationItems()` source path, which both preview and
execution could invoke. The installed revision requested a total on every page.
The later checkout counted only the first page, but still repeated the full
per-user catalog traversal.

During the workload, Emby's main-process RSS grew from approximately 5.5 GiB to
24.6 GiB, and its thread count grew from 34–37 to 153. Playback-progress requests
had a median response time near 37 seconds, with some exceeding 100 seconds.
There were 234 queued progress completions during a three-second interval. Later,
progress responses returned to 4–5 ms without another Emby restart.

This strongly implicates contention between the migration catalog reads and
playback-state writes. It does **not** identify the internal lock owner, prove a
particular SQL query plan, or attribute retained memory to particular object
types. Deep OFFSET pagination and repeated sorting are potential costs, not
proven query-plan diagnoses. Earlier incidents remain a separate investigation.
The supplied storage and proxy observations do not support moving transcodes or
changing proxy caching as the fix for these source requests.

## The replacement read path

Live preview checks account identities, mappings, and destination protections.
It does not enumerate source or destination libraries or source playlists. Its
history statistics are explicitly deferred rather than shown as zero. Approval
starts the complete migration; matching details and unmatched or ambiguous items
appear in its results. A preview using a saved database snapshot can still show
history details before approval.

An approved live migration separates two kinds of source information:

1. **Reusable matching metadata.** One user-neutral `/Items` traversal collects
   the supported media types, provider identifiers, paths, series identifiers and
   episode/season numbering. `EnableUserData=false` excludes personal state. The
   retained projection contains only fields used by matching, review labels, or
   merge safety. This catalog is shared across users in a job, rather than read
   again for each preview and account.
2. **Fresh account state.** For each account, `/Users/{id}/Items` reads explicit
   batches of catalog `Ids`. These requests omit recursive enumeration, media-type
   filtering, name sorting and total counts. They request user state and Emby's
   explicit playback count/date fields. The API may omit deleted or inaccessible
   IDs. Unexpected or repeated IDs and changed item types fail the read.

The in-process metadata cache is bound to the source URL, API key, server identity
and version. Its normal reuse window is ten minutes, measured from the beginning
of collection. A running job pins its catalog so that crossing the cache expiry
does not trigger another catalog crawl halfway through a bulk migration. Source
personal state is not cached across users. Connection changes invalidate reuse;
failed or incomplete catalogs are not published as successful cache entries.

The cold metadata traversal still uses the documented `SortName` order. No
verified common ID tie-breaker or continuation cursor was found, so this patch
does not invent an `Id` sort or use an unsupported cursor. It removes name sorting
from the repeated state reads, not from the one cold matching traversal. Repeated
catalog IDs fail closed. Concurrent library edits can still shift OFFSET pages
without producing a detectable duplicate: a live catalog is a bounded-age view,
not an atomic database snapshot. Additions and metadata changes after collection
can require another migration.

## Why complete state is not a union of three filters

The API behavior was checked using an isolated official Emby 4.10.1.0 container,
synthetic accounts, and twenty synthetic movies. No production server was used.
The request parameters were checked against Emby's documented
[`/Items`](https://dev.emby.media/reference/RestAPI/ItemsService/getItems.html)
and
[`/Users/{id}/Items`](https://dev.emby.media/reference/RestAPI/ItemsService/getUsersByUseridItems.html)
contracts; the observations below describe the isolated runtime checks rather
than assuming every documented filter has the required semantics.

| Verified request behavior                                                                                                                              | Consequence                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Neutral `/Items` requests returned matching metadata without `UserData`; disabled totals were reported as zero.                                        | Catalog pagination cannot use those zero totals as its stopping condition.                                                   |
| User-scoped `Ids` requests worked without `Recursive`, `IncludeItemTypes`, or `SortBy`.                                                                | State reads can avoid a full per-user recursive catalog sort.                                                                |
| Explicit `UserDataPlayCount,UserDataLastPlayedDate` fields returned stored counts and dates; omitting them did not reliably return those values.       | Complete migration retains these two fields on state requests.                                                               |
| Reversed ID lists retained their requested order; a server-clamped limit produced successive smaller pages. Invalid and inaccessible IDs were omitted. | State pagination validates returned IDs and continues within the bounded batch instead of assuming one response is complete. |
| An unplayed item with a positive play count/date, and a date-only item, were absent from played/favorite/resumable filtered results.                   | Those filters cannot replace complete account-state reads.                                                                   |
| Multiple filters behaved as AND; likes/dislikes filters did not select the intended subset.                                                            | The implementation does not depend on an unverified filter union.                                                            |

Complete migration therefore examines state for every catalog ID, then retains
only supported personal state. This preserves watched status, play counts,
timestamps, resume positions, favorites, likes/dislikes and supported ratings,
including a false like and a zero rating. Container favorites and ratings remain
eligible; derived container playback totals remain excluded as before.

Complete migration still reads playlist definitions and entries, and preserves
the existing private-copy and duplicate-entry behavior. New-account preferences
and supported avatars retain their existing behavior. Watched-only remains an
explicit user choice; it does not silently become the complete mode.

Jellyfin matching and account access remain destination-scoped. Potential detailed
state writes still refresh Jellyfin's current user data immediately before the
additive merge. Newer Jellyfin activity, existing favorites and watched status
remain protected. Migration has no distributed transaction or automatic rollback;
canceling preserves changes already applied and reports the need to review.

The exact reported Jellyfin 12.2.0 container release was not available for an
isolated runtime verification. This investigation verifies the new source query
contract against Emby 4.10.1.0, not a claim of exact-version Jellyfin runtime
coverage. Destination merge behavior is covered by automated fixtures.

## Conservative defaults

These limits apply without server-owner tuning:

| Limit                                   | Default                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| Active source migration API reads       | 1 across source clients                                          |
| Queued source read admissions           | At most 8                                                        |
| Idle time after a source read completes | At least 500 ms                                                  |
| Slow-response threshold                 | 2 seconds; stop the read workload and open the circuit           |
| Source read deadline                    | 5 seconds                                                        |
| Circuit cooldown                        | At least 5 minutes; reject queued work rather than retry it      |
| Source catalog/playlist page size       | At most 100 items                                                |
| IDs in a state batch                    | At most 100, and at most 6,000 encoded characters                |
| Matching catalog                        | At most 200,000 items and 64 MiB of retained serialized metadata |
| Retained personal state                 | At most 100,000 items and 32 MiB of retained serialized data     |
| Catalog cache reuse window              | 10 minutes; one catalog pinned during a job                      |

Heavy source reads do not automatically retry HTTP 429, server errors, timeouts or
network failures. Slow responses, failures and cancellation of an active request
open the cooldown and release queued callers with a safe error. A valid server
Retry-After duration extends the default cooldown, bounded to 24 hours. The
five-minute minimum exceeds the observed 100-second-plus incident responses;
it is still not proof that an upstream query has finished. Work does not
automatically resume when the cooldown expires.

Cancellation interrupts queued admission, idle waits, request bodies and active
requests. Canceling before admission does not start a cooldown because no request
was made. The governor also bounds an injected transport that ignores
cancellation on the Jellyport side. Canceling a client request cannot guarantee
that Emby has stopped work already accepted by its server; the active-cancellation
hold prevents an immediate manual retry from creating more upstream overlap.

The byte limits measure retained serialized payloads, **not** a hard process RSS
limit. JavaScript objects, response buffers, sets and matching indexes also use
memory. Source playlists also have a 32 MiB per-read and aggregate retained
serialized-payload budget, alongside 500-playlist/100,000-entry limits. Pages are
validated and retained data is bounded incrementally so a
large library does not become an unlimited object array. Limit failures require
review or a saved snapshot; they do not trigger a fallback to the old full
per-user crawl.

The defaults favor playback protection over migration speed. A 100,000-item
catalog needs at least 1,000 state batches per account, so the idle intervals alone
take about eight minutes per account. Request processing and destination writes
add time. For large bulk moves, saved snapshots avoid repeated live source-state
API reads, while still carrying disk-I/O costs during capture. The legacy Online
Backup method can also delay WAL checkpoints while its source transaction stays
open.
No approach here guarantees zero impact on an actively used media server.

## Scheduled best-effort file copies

`JELLYPORT_SNAPSHOT_METHOD=file_copy` on the optional helper selects ordinary
scheduled file copying. The same daily schedule and timezone are reused. It needs
no ZFS, downtime, backup plugin or special storage. The helper opens source files
read-only and streams only `library.db`, `users.db` and their available WAL files
into private work space; it does not query SQLite on the live source or copy
`-shm`, authentication databases or unrelated configuration. A single capture
supplies library history for all users.

SQLite performs normal WAL recovery on the private copies, followed by integrity
and supported-schema validation. Only the allowlisted encrypted migration
projection is published. Raw library/users/WAL copies remain in helper-only work
space until cleanup; the raw user database can contain private account data.
Damaged, incompatible or unresolvable captures retain the last good projection.
There is no `.recover` salvage, adoption of repaired data, or automatic fallback
to live history reads. Capture metadata labels this method `file_copy`; old
records without a method retain the `sqlite_online_backup` meaning.

This is explicitly best effort. File copies taken during writes do not provide
an atomic database view, and structural integrity cannot prove complete or current
history. Normal WAL recovery can disregard incomplete or uncommitted tail data.
Copies can fail or miss activity even while the source server is healthy. Avoiding
a source SQLite read transaction removes that capture's read-lock/checkpoint hold;
it does not remove disk traffic, private-copy recovery/projection CPU cost or all
possibility of playback impact. The existing Online Backup method remains the
default when the helper method is omitted. Both have the capture deadline and
retention/size limits documented in [deployment](docker-deployment.md#optional-local-emby-snapshots--0120).

Saved history does not make the entire migration offline. Current source identity
still comes through the API; Complete mode also obtains supported account
configuration, profile images and playlist metadata/entries live. Jellyfin access
and destination state remain live. Neither capture method makes these separate
databases and API responses one consistent transaction.

## Local snapshot performance

The local history reader starts with one user's indexed meaningful state and
looks up matching catalog rows by key. New private projections use a partial
index covering watched flags, positive counts, favorites, resume positions,
playback dates and ratings, including zero ratings. Every original projected
state row remains in the database; older full-index projections still work.
These indexes belong only to Jellyport's private projection, never Emby's live
database or its backup files.

SQLite no longer sorts the joined history before iteration. The reader validates
the row and serialized-byte ceilings first, then sorts the bounded result by item
ID for deterministic matching. Native SQLite caches use an 8 MiB limit, temporary
data uses disk, and memory mapping is disabled. These controls do not establish
a hard process RSS ceiling.

An active bulk job retains one decrypted projection per selected generation
across long Jellyfin write phases. The previous 60-second idle eviction could
force the next account to decrypt the whole database again. Jobs release their
references on completion, failure and cancellation; the final reference removes
idle plaintext promptly. Shared in-flight readers finish before removal, and
shutdown drains them and removes decrypted files. Failed removals remain tracked
for a later clear/shutdown attempt; cleanup errors are sanitized, idle failures
cannot reject an unhandled promise, and new decryptions stop until cleanup
succeeds. Standalone
previews retain the existing short idle cache. Personal account results are not
cached between users.

Each destination catalog now builds one matching index for both history and
playlist planning. New-account snapshot previews reuse their existing shared
metadata catalog and index; existing accounts still read their own Jellyfin
state. A matching plan retains at most 200,000 ambiguous candidate references.
Over-limit plans fail rather than drop candidates or guess a match. Item workers
yield every 250 processed items so large already-merged histories remain
cancelable. Fresh pre-write Jellyfin checks and the four-worker ceiling remain.

Run `npm run benchmark:snapshots` for an opt-in, synthetic-only benchmark. It
accepts no production paths or URLs, generates 100,000 catalog items and 500,000
state rows across 100 users, and removes its temporary workspace. Five runs of
each query/index strategy compare complete output checksums. On one Apple M5
Mac with Node 22.23.2/SQLite 3.53.4, projection took approximately 161 ms and
extracting 50,000 meaningful history records across all 100 users took a median
431 ms with the old SQL sort/full index versus 230 ms with the optimized partial
index. All outputs were identical.

These are local component measurements, not an end-to-end migration estimate or
a memory benchmark. Strategies use the same cache settings and final bounded
JavaScript sort; sequential runs can benefit from filesystem caches. Backup
creation, decryption, subprocess startup, matching and Jellyfin API work are
excluded. Every destination account still requires its permission-scoped catalog
read, and every potential change still needs fresh state before a write. Those
network operations can dominate total duration; higher write concurrency is not
assumed safe. Verified full-backup history imports are available as described in
[the plugin guide](emby-plugin-backups.md). They use the same local projection,
indexed reads, bounded matching and merge safeguards. Plugin imports never query
live SQLite; original backup age, source identity, strict copy stability and
integrity are checked before adoption. Importing the same generation preserves
its original age and does not accumulate duplicate retained projections.

## Observability and verification

Source workload events contain fixed operation labels and aggregate numbers:
API calls, accepted pages/items, per-read latency, cumulative duration, active and
queued work, cache hits/items, cancellations, failures and remaining cooldown.
Events exclude credentials, tokens, request URLs, query strings, account and item
identifiers, titles, paths, playback positions and response bodies. A logging
failure must not change admission, cancellation or migration results.

Automated validation uses mocked large catalogs and isolated synthetic fixtures.
It covers bounded duplicate catalog work, page and payload limits, clamped
pagination, unexpected/repeated IDs, state that filtered queries miss, cache scope
and failure handling, preserved Jellyfin activity, and cancellation during
admission, idle waits, active reads and timeouts. The workload governor's tests use
an injected clock/sleeper where appropriate; they do not establish production
throughput or identify Emby's internal contention mechanism.

The 0.13.0 change was merged on **2026-10-13** in
[PR #11](https://github.com/Cruv/Jellyport/pull/11); its verification included no
production deployment or load test. The source/runtime observations and dated
component measurements above retain their original scope. They are not fresh
production approval or a required audit for every later edit.

For an explicitly authorized production migration trial, agree on accounts,
request/page budget, observation window and stop conditions. Use existing
read-only playback-latency, RSS/thread and active-session telemetry as a baseline,
then start with a bounded check and one account. Approval for reads does not
authorize destination writes. Increase scope only after reviewing that evidence;
cancel if playback degrades. Do not create synthetic production playback, disable
client reporting, change Emby's databases/indexes or automatically restart servers.

The authorization boundary is canonical in [AGENTS.md](../AGENTS.md); proportional
local verification and evidence reuse are in [development procedures](development.md).
This operational trial guidance applies to live workloads, not documentation-only
changes, local mocks or already authorized read-only backup inspection.
