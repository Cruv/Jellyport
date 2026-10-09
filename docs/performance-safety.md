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

No production deployment or load test is part of this patch. A conservative
approval plan is:

1. Review the patch, automated results and the source query contract first.
2. Obtain separate approval before deploying a candidate or running migration
   workload against production. Agree on the accounts, request/page budget,
   observation window and stop conditions beforehand.
3. Establish playback-progress latency, Emby RSS/thread count and active-session
   baselines using existing read-only telemetry. Do not create synthetic playback
   or disable client progress reporting.
4. Start with a bounded, explicitly approved source-read check and one account.
   Observe source latency and memory while retaining the governor's defaults.
   Approval for reads does not authorize destination account or state writes.
5. Increase the scope only after reviewing that evidence. Cancel Jellyport work
   if playback degrades; do not automatically restart either media server.

This patch does not alter Emby's databases or indexes, move transcode storage,
disable playback reporting, change proxy caching, or restart media servers.
