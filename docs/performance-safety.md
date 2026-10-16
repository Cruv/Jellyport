# Migration workload and playback safety

Current migration transfers **played / unplayed flags only**. It never clears an
existing Jellyfin played flag and does not import resume positions, counts, dates,
favorites, ratings, playlists, source preferences or profile images. Backup
projections may retain broader fields for format compatibility; only matching
metadata and played flags drive the current transfer. Historical investigations
and measurements below retain their original inputs and limitations.

## Played-only production trials — 2026-10-16

A representative heavy history on version 0.16.0 took **136.3 seconds** from
queueing through independent readback. Shared preparation was reported separately:
about 63 seconds to import the Emby plugin backup and 280.9 seconds to import the
Jellyfin matching catalog (194,633 items). Per-user phases were source extraction
0.6 s, provisioning 0.4 s, candidate reads 11.8 s, matching 0.6 s, writes 114.4 s,
and independent verification 8.5 s. Timings are rounded.

The accepted job met the five-minute time limit and missed the two-minute target;
review preparation was not timed, so this run alone does not prove the combined
workflow limit. It was
**partial**, not a correctness acceptance: 20,597 played flags verified, 12 matched
items mismatched after HTTP 500/404 responses, 635 source items were ambiguous,
and 1,719 orphan history entries had no remaining source library item. Failures
were reported rather than converted to success. A Jellyfin metadata provider-key
collision explained one deterministic HTTP 500. Subsequent read-only inspection
found that all eleven HTTP 404 items belonged to a library excluded by the trial
account's copied template permissions. No access check was bypassed.

Version 0.16.1 adds bounded administrator-only failed-item diagnostics and aggregate
write/checkpoint timings. It raises destination write concurrency from four to six
and limits observational progress saves to once per second plus a final flush.
Account creation uncertainty journals remain immediate.

A fresh three-account trial on 0.16.1 measured review readiness within **5.142
seconds**, followed by **205.2 seconds** for the accepted job, including writes to
live Jellyfin and independent live verification. The combined workflow took at
most **210.342 seconds**, excluding the human review pause. This is partial
performance success under the five-minute threshold; it misses the two-minute
target for the whole bulk operation. Account work was serialized:

| History size | Account work | Played flags written and independently verified | Failed updates | Ambiguous source items | Orphan source history |
| ------------ | -----------: | ----------------------------------------------: | -------------: | ---------------------: | --------------------: |
| Heavy        |      132.8 s |                                          20,597 |             12 |                    635 |                 1,719 |
| Typical      |       12.5 s |                                           1,801 |              0 |                     12 |                    38 |
| High         |       59.7 s |                                           9,283 |             87 |                     39 |                   977 |

Account-work times exclude waiting behind earlier accounts and must not be
presented as isolated end-to-end results. All three accounts finished within the
combined bulk duration above. Every run remained **Needs review** because source
exceptions or failed verification remained; timing did not override those results.
No live Emby catalog was scanned. Shared backup imports remained approximately
63 seconds for Emby and 280.9 seconds for Jellyfin, outside the per-migration timer
and reusable across accounts.

An existing-account trial on 0.16.0 took 19.4 seconds after acceptance and verified
2,938 unique played flags with no missing or mismatched matches. One unmatched
item, 50 ambiguous items and 545 orphan history entries kept it partial. Its review
time was not measured. A heavy existing-account rerun on 0.16.1 took 28.3 seconds
after acceptance, skipped the 20,597 already-verified flags and retried only the
twelve failures; it did not rewrite the successful flags. These runs demonstrate
live writes and repeatability, not a backup-only benchmark or a measured combined
two-minute result.

The 0.16.2 isolated heavy trial recorded **154.9 seconds** combined server work:
0.1 seconds review preparation and 154.7 seconds accepted work, with live writes
and independent readback. It verified 20,597 flags but retained all twelve failures.
The ineffective view passes cost 26.6 seconds preparation and 25.9 seconds readback;
eight writers took 100.6 seconds, versus 107.9 seconds with six in the prior fresh
trial. This was partial performance success, not a corrected access result.
Version 0.16.3 removes those redundant reads and returns to six writers. Its new
neutral membership index had 100% Movie/Episode coverage in the inspected backup,
with no unknown candidates for the three sampled histories. Final local import plus
index construction took 60.06 seconds without API calls or writes; this is preparation
evidence, not production migration acceptance.

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

Every preview checks account identities, mappings, and destination protections.
Saved-history previews also validate the backup's server binding, original age,
user identity and generation, and pin that generation for approval. Neither mode
decrypts history, enumerates source or destination libraries, or reads playlists.
History statistics are explicitly deferred (`stats: null`), rather than shown as
zero. Approval starts the history preparation and migration; matching details and
unmatched or ambiguous items appear in its results. A preview never starts a cold
catalog build in the background.

An approved live migration separates two kinds of source information:

1. **Reusable matching metadata.** One user-neutral `/Items` traversal collects
   the supported media types, provider identifiers, paths, series identifiers and
   episode/season numbering. `EnableUserData=false` excludes personal state. The
   retained projection contains only fields used by matching, review labels, or
   merge safety. This catalog is shared across users in a job, rather than read
   again for each preview and account.
2. **Fresh account state.** For each account, `/Users/{id}/Items` reads explicit
   batches of catalog `Ids`. These requests omit recursive enumeration, media-type
   filtering, name sorting and total counts. They request user state; only played playable items are retained for migration. The API may omit deleted or inaccessible
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

## Saved destination matching — 0.15.0

The preferred large-library path imports a completed native Jellyfin database-only
backup through the network-isolated helper. It streams only the manifest, BaseItems
and BaseItemProviders into an allowlisted SQLite projection with disk indexes.
The web service receives an encrypted neutral catalog, never the original archive.
Each account loads only indexed identity candidates and their series dependencies;
all candidate IDs and identity fields are checked through fresh user-scoped API
reads before matching. Played updates send only the additive `Played: true` field,
and independent batched readback verifies intended played flags afterward.
A successful HTTP update alone is not evidence of completed migration.

Set `JELLYPORT_JELLYFIN_CATALOG_MODE=backup` on the web service so the first startup
also refuses live catalog scans. Importing is explicit and shared across users;
preview never starts an import or catalog crawl. Queueing pins a generation;
missing, expired, changed or incompatible data fails closed, including helper
outages. Original backup age is limited to 48 hours, without renewal on reimport.
The last good catalog survives import failure. See the [setup and repeatable
procedure](jellyfin-backup-catalog.md).

Projection and matching indexes stay on disk: at most two million supported items,
8 GiB projected database, 8 MiB SQLite page cache per connection. Per-account
candidate limits remain 200,000 items / 64 MiB, and source history remains bounded
separately. Limits reject work rather than truncate it. Import and candidate workers
have five-minute deadlines; cancellation kills and reaps the worker. Decryption is
shared per generation with bounded idle retention, not repeated per account.
No live media-server database is modified or opened by this import.

The independent readback retains pre-write played-state expectations, including
no-op matches and multiple source editions mapping to one target. Missing,
mismatched or unsupported played values make the result partial. Writes use only
`Played: true` through the modern partial-field API, preserving unrelated destination
state. The legacy watched endpoint is not used because it can alter counts, dates
or resume state. Unmatched and ambiguous identities remain explicit and are never
guessed.

The performance acceptance measure is **review preparation plus accepted migration
elapsed time**. It includes history extraction, matching, writes to the live Jellyfin
server, retries, independent live readback, preflight and queueing. Time spent by the
administrator reading the ready review is excluded. Under two minutes is the target;
two to five minutes is a partial performance success, not the highest-success result.
Timing success does not turn unmatched items or failed verification into a complete
migration. Backup-only matching benchmarks cannot establish this acceptance measure.

Job elapsed time covers the server migration request, including preflight validation,
queue admission, final verification and completion. That timer alone excludes review
preparation; older trial results without separately measured review time cannot prove
the combined target. Browser/network overhead is measured separately in a trial.
Per-account timings include extraction, matching, writes, retries and verification;
shared import time and original backup dates appear separately. A bulk job's wall
time is authoritative: individual account work does not include its wait behind
other accounts or once-per-job provisioning checks. Neither CPU-only simulation nor
shared preparation establishes the five-minute target-environment acceptance limit.

## Legacy live destination matching without a full per-user crawl

When saved destination mode is not configured, an approved migration collects one user-neutral Jellyfin catalog, or reuses a
matching cached catalog, and pins it across every account in that bulk job. Its
in-process reuse window is ten minutes from successful completion of collection;
the recorded capture time remains the beginning of collection. The
cache key includes the destination URL, API key, server ID and version; changes
invalidate reuse. Personal state never enters this cache, and incomplete or failed
catalog builds are not published. A job retains its selected catalog even if the
normal reuse window expires while transferring users.

One matching index selects the union of all type-scoped provider, series/episode
number and exact mapped-path candidates for eligible played source history.
Lower-priority and contradictory identity candidates remain in
that union: removing an inaccessible provider match can reveal a series or path
fallback, or change whether a match is ambiguous. Parent series needed to verify
derived series identifiers are included as dependencies. Unrelated destination
items are not read again for each account.

Jellyfin account reads use fresh folder permissions and a neutral saved membership
index. The index records an item's physical root and its associated logical library
IDs, with inconsistent or missing relationships left unknown. A candidate allowed
by current policy receives one bounded explicit-ID metadata/state read only after
a fresh logical-library/location fingerprint matches the saved configuration.
Changed configuration fails before writes and requires a new matching backup;
the same check runs during independent verification, including no-op played flags.
Unknown or
apparently denied candidates first receive a target-scoped UserData GET using the
same standalone visibility check as the write endpoint. A confirmed 404 removes
that candidate; a 200 keeps it for fresh identity validation, preserving legitimate
items when saved membership is stale. These checks do not request on-demand metadata
refresh. Existing template/library restrictions remain unchanged.

There are at most 2,048 exception checks per invocation, four read-only workers and
a 60-second exception-phase deadline including retries. Exceeding the budget stops
further checks before writes and requires a fresh membership-bearing matching
backup. Large v1 or live catalogs without those hints can hit that limit. All workers
abort and drain on fatal failure or cancellation. The normal metadata/state pass
uses batches of at most 170 IDs and 6,000 encoded characters, without name sorting,
total counts or repeated views. Independent readback refreshes policy and checks
again. Unexpected omissions share the same exception budget: exact target-scoped
access distinguishes a real 404 from Jellyfin version grouping, and accessible
missing items receive a single-ID identity/state read. If that also omits the item,
the read fails rather than silently discarding history. Destination batches use
170 IDs within the unchanged 6,000-character URL bound; source batches remain 100.
Aggregate `user_access` events omit user and item identities.

Jellyfin's explicit-ID query alone does not enforce enabled libraries. Version
0.16.2 attempted to intersect IDs with views, but the live trial disproved that
assumption: the [controller clears Parent](https://github.com/jellyfin/jellyfin/blob/ca0f16eb7c195f720a1493ed469a27c4657db0c6/Jellyfin.Api/Controllers/ItemsController.cs#L589),
whose [setter also clears ParentId](https://github.com/jellyfin/jellyfin/blob/ca0f16eb7c195f720a1493ed469a27c4657db0c6/MediaBrowser.Controller/Entities/InternalItemsQuery.cs#L452).
The extra passes doubled reads without filtering inaccessible items. They were
removed; fixtures now model that actual API behavior. The fresh access check uses
[the same item lookup as the POST](https://github.com/jellyfin/jellyfin/blob/ca0f16eb7c195f720a1493ed469a27c4657db0c6/Jellyfin.Api/Controllers/ItemsController.cs#L1078).

The request shape was checked against Jellyfin's tagged
[Items controller](https://github.com/jellyfin/jellyfin/blob/v10.11.6/Jellyfin.Api/Controllers/ItemsController.cs#L300),
[explicit-ID lookup](https://github.com/jellyfin/jellyfin/blob/v10.11.6/MediaBrowser.Controller/Entities/Folder.cs#L833)
and [DTO access filtering](https://github.com/jellyfin/jellyfin/blob/v10.11.6/Emby.Server.Implementations/Dto/DtoService.cs#L148).
Explicit IDs bypass recursive folder discovery, and the supplied batch limit is
forwarded without a server-side clamp in that source. Unlike the separately
verified Emby source adapter, the Jellyfin adapter does not advance OFFSET by the
number of visible DTOs: visibility filtering can omit entries after pagination.
Each bounded ID batch is requested once. Exact production-version behavior has
not been exercised by this patch. The separately approved 0.14.1 trial stopped at
the first destination catalog page's five-second deadline before history writes.

The cold Jellyfin traversal explicitly sends `CollapseBoxSetItems=false`. In
Jellyfin's pinned [folder query implementation](https://github.com/jellyfin/jellyfin/blob/10662e75e4626be71184db950ce534ab6953be77/MediaBrowser.Controller/Entities/Folder.cs#L1131),
an omitted flag defaults to collection collapsing for neutral Movie/Series
queries. That activates [post-filtering](https://github.com/jellyfin/jellyfin/blob/10662e75e4626be71184db950ce534ab6953be77/MediaBrowser.Controller/Entities/Folder.cs#L874),
which can enumerate the recursive library before applying the requested page
limit. Disabling this supported option lets the uncollapsed query use
[repository pagination](https://github.com/jellyfin/jellyfin/blob/10662e75e4626be71184db950ce534ab6953be77/Jellyfin.Server.Implementations/Item/BaseItemRepository.cs#L286)
and retains individual movies, series and collection records for matching. This
source behavior explains a plausible cold-page bottleneck; it does not establish
the exact production server's query plan or attribute all elapsed time to it.

Collection remains sequential with documented `SortName`, at most 100 items per
page, no total counts, and an empty page as its stopping condition. It leaves
100 ms of cancelable idle time between pages. Jellyfin catalog pages have a
30-second deadline and no automatic retry; the complete build has a 15-minute
deadline, including reads, waits and metadata preparation. Failure or cancellation
discards the partial index. These destination limits do not relax Emby's separate
five-second deadline or source governor. Explicit-ID account reads retain their
30-second deadline and at most three attempts for HTTP 429/503, with each retry
delay capped at two seconds. Reads do not fan out. That release kept a four-worker ceiling for independent destination item
transfers. Current played-only writes use at most six workers; account jobs remain
serialized and no mutation is retried automatically. Cold collection
still costs database work; sharing it removes repeated per-account work.

Both the neutral catalog and each account's retained candidate result are bounded
to 200,000 items and 64 MiB of serialized data. Candidate selection deduplicates
index work and visits each shared identity bucket once. These are payload bounds,
not a JavaScript heap or process RSS ceiling. Matching indexes, response buffers,
source history and the separate source catalog also consume memory. There is no
fallback to a full per-user destination crawl when a bound or validation fails.

[JellyPlex-Watched's activity queries](https://github.com/luigi311/JellyPlex-Watched/blob/1741166ee439a97d936a0e3a3d39fec4500dd757/src/jellyfin_emby.py#L306)
and its [watched-state model](https://github.com/luigi311/JellyPlex-Watched/blob/1741166ee439a97d936a0e3a3d39fec4500dd757/src/watched.py#L39)
inform the separation of reusable matching metadata from account activity. That
project still enumerates destination libraries; it is not a drop-in solution to
this bottleneck. Jellyport now limits transfer to played flags; resume filters and
other personal-state transfer are outside its scope. Any future filtered-query
optimization still needs behavior checks for identity, access and pagination.

## Historical complete-state filter investigation

This section records the earlier broad-state design. Current migration uses played
flags only; the observations remain evidence about API behavior, not a claim that
counts, dates, favorites or resume positions are still migrated.

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

The earlier Complete live-source migration examined every source catalog ID,
retaining supported personal state; saved sources used the private indexed
projection instead. It covered watched status, counts, dates, resume, favorites,
likes/dislikes and ratings, including false likes and zero ratings. Container
favorites and ratings were eligible; derived playback totals were excluded.
Those broader transfer semantics are no longer supported.

That historical Complete path also read playlists, account preferences and avatars.
Current migration no longer reads or transfers those groups; Jellyfin roles and
templates still provide new-account defaults independently.

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

| Limit                                   | Default                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Active source migration API reads       | 1 across source clients                                                                           |
| Queued source read admissions           | At most 8                                                                                         |
| Idle time after a source read completes | At least 500 ms                                                                                   |
| Slow-response threshold                 | 2 seconds; stop the read workload and open the circuit                                            |
| Source read deadline                    | 5 seconds                                                                                         |
| Circuit cooldown                        | At least 5 minutes; reject queued work rather than retry it                                       |
| Source catalog/playlist page size       | At most 100 items                                                                                 |
| IDs in a state batch                    | At most 100, and at most 6,000 encoded characters                                                 |
| Live matching catalog, per server       | At most 200,000 items and 64 MiB of retained serialized metadata                                  |
| Retained source personal state          | At most 100,000 items and 32 MiB of retained serialized data                                      |
| Jellyfin catalog page size              | At most 100 items                                                                                 |
| Jellyfin catalog idle interval          | 100 ms between pages                                                                              |
| Jellyfin catalog deadlines              | 30 seconds per page; 15 minutes for the full build                                                |
| Retained Jellyfin candidate state       | At most 200,000 items and 64 MiB of retained serialized data                                      |
| Catalog cache reuse window              | Source: 10 minutes from start; destination: 10 minutes from completion; each job pins its catalog |

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
memory. Current migration does not read source playlists. Pages are
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
still comes through the API. Emby preferences, profile images and playlists are
not read for transfer. Jellyfin access and destination state remain live. Neither capture method makes these separate
databases and API responses one consistent transaction.

## Local snapshot performance

The local history reader selects one user's played playable items and looks up
matching catalog rows by key. Existing private projections can contain broader
allowlisted meaningful state and partial indexes covering it. Those formats remain
readable without enabling broader transfer; older full-index projections still work.
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
succeeds. Previews no longer decrypt a projection or start a history reader.
Personal account results are not cached between users.

Each approved job builds one neutral destination matching index for played-state
candidates. Each account receives fresh access-scoped data only for its candidates
and reuses that account's matching index. A matching plan retains at most 200,000 ambiguous
candidate references.
Over-limit plans fail rather than drop candidates or guess a match. Item workers
yield every 250 processed items so large already-merged histories remain
cancelable. Fresh access-scoped Jellyfin candidate checks remain. Played-only destination writes have a six-worker ceiling; account jobs stay serialized and workers drain before cancellation releases locks.

The following benchmark measurements predate the played-only scope and describe
local component work, not current end-to-end throughput.

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
excluded. Every destination account still requires permission-scoped candidate
reads, and every potential change still needs fresh state before a write. Those
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

Jellyfin catalog and candidate-page events report operation, outcome, page latency
and item count. Service totals add completed pages, cumulative items, read
HTTP attempts (including retries), accumulated read duration and metadata-cache hits. Canceled and
failed reads are reported without upstream response bodies. These counters cover destination
preparation reads, not a complete playback-impact metric or every write. They
follow the same exclusions for credentials and personal playback details.

Jobs distinguish shared index preparation from account history reads. During a
cold build the interface reports accepted pages, cumulative indexed items and last
page latency, including a waiting-for-first-page state. These are aggregate
counters, not an estimated completion percentage. Checkpoints are persisted at
most once per second after the first accepted page, with an additional final flush.
Progress observers cannot change catalog acceptance or migration results.

## Local destination verification

On October 16, 2026, the 0.14.2 synthetic benchmark used the same 100,000-item,
100-account fixture with safer 100-item catalog pages. It observed 1,001 catalog
reads (including the empty terminal page), 200 account-state reads and 100 cache
hits, with 20,000 matches and no proposed changes to newer destination activity.
The 1,201 requests are about 94% fewer than the old 20,000-request per-user
catalog traversal, excluding previews. Smaller pages increase request count versus
0.14.1 while reducing each requested response's size; the collection-collapse fix
addresses server-side work that request count alone cannot measure. The injected
transport disabled production pacing. Its 3.102-second local pipeline timing
excludes the normal 100 ms intervals, backup I/O, network and writes, and does not
estimate production performance or memory peaks.

A separate loopback-only official Jellyfin 10.11.10 container verified a synthetic
20-item catalog spanning all 15 supported types. Both omitted and disabled
collection collapsing returned the same 20 unique IDs across clamped pages of
7, 7, 6 and 0 items, with provider IDs/paths and no neutral personal state. A
user-scoped explicit-ID request returned all 20 accessible items with personal
state. The fixture used an owned offline database seed, so this validates the
request contract rather than natural library-scanner behavior. Repeated local
container startup crashes prevented a valid 100,000-item API timing comparison;
small warm-order timings are not a performance claim. Production's reported
Jellyfin version remains a separate verification target.

### Earlier 0.14.1 measurement

On October 15, 2026, `npm run benchmark:destination` exercised the production
catalog reader, metadata cache, candidate selection, explicit-ID reader and merge
planner with an injected in-memory transport. It used 100,000 synthetic catalog
items and 100 users with 200 relevant items each. It observed 201 catalog reads
(including the final empty page), 200 account-state reads, 100 cache hits and
20,000 successful matches. No changes were proposed against the newer synthetic
destination activity. The previous full per-user migration traversal would require
20,000 catalog requests for this fixture, excluding its separate preview pass.
The new 401 requests represent about 98% fewer reads in this scenario.

One local run took 1.843 seconds for the synthetic pipeline. This excludes backup
I/O, encryption, network latency and destination writes; it does not estimate
production duration, memory peaks or playback impact. The benchmark accepts no
production inputs and cannot contact media servers. Run it again to measure code
changes against the same bounded fixture.

Automated validation uses mocked large catalogs and isolated synthetic fixtures.
It covers bounded duplicate catalog work, page and payload limits, clamped
pagination, unexpected/repeated IDs, state that filtered queries miss, cache scope
and failure handling, candidate access filtering and identity changes, playlist-only
members, preserved Jellyfin activity, and cancellation during
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
