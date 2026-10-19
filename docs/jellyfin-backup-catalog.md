# Saved Jellyfin matching catalog

For a large library, use a completed native Jellyfin backup for item matching
alongside the [Emby plugin backup](emby-plugin-backups.md) for source history.
This avoids the live destination catalog traversal and its OFFSET/sort behavior.
It does not restore a database or import Jellyfin users, passwords or saved history.
Fresh destination account access and playback activity remain authoritative.

## Setup

1. In Jellyfin's admin dashboard, create a **database-only backup**. Metadata,
   subtitles and trickplay are unnecessary. Wait until Jellyfin reports completion.
   The completed backup must be no more than 48 hours old when imported and used.
   Creating this backup can consume server resources. After initial setup, the
   optional create-before-import schedule below can replace this manual step.
2. Mount only the actual directory containing completed
   `jellyfin-backup-YYYYMMDDHHMMSS.zip` files read-only into the snapshot helper at
   `/jellyfin-backups`. Set its `JELLYPORT_JELLYFIN_BACKUP_DIR=/jellyfin-backups`.
   Keep this raw archive mount out of the web container. Archives contain sensitive
   accounts and credentials, even though the importer ignores those entries.
3. Set `JELLYPORT_JELLYFIN_CATALOG_MODE=backup` on the **web** service. This disables
   live destination catalog scans even before the helper's first heartbeat. Both
   services must use the same 0.15.0-or-later image and private exchange directory.
   The [plugin Compose example](../examples/compose.plugin-backups.yaml) includes
   both backup mounts; replace generic paths with local Docker-host directories.
4. In Jellyport, open **Settings → Saved history → Jellyfin catalog** and choose
   **Import latest Jellyfin backup**.
   Review its original backup date, expiry and item count. An unavailable helper
   prevents new imports; an already valid imported catalog can still serve jobs.

## Daily import scheduling

Both **Emby backup** and **Jellyfin catalog** under **Settings → Saved history**
have their own daily schedule. Expand **Daily schedule**, enable it, choose a time
and explicit IANA time zone, then save that schedule. Scheduling is off by default.
The saved summary shows the actual configuration and next run; the import status
shows the last attempt and its outcome separately from the last usable backup.
Manual import and schedule saves do not save unrelated Settings drafts or change
each other's configuration. Refreshing status preserves unsaved schedule edits;
if another administrator changes the saved revision, explicitly reload it before
saving again.

By default these schedules import existing completed backups. Emby backups still
come from its Backup & Restore plugin. Jellyfin additionally offers the opt-in
creation step below. Imports share one work slot, including backup creation and
preparation, so Emby and Jellyfin imports cannot start concurrently. A manual
request reports that the slot is busy; a scheduled run waits within its catch-up
window. This also avoids accepting work that would expire in the helper's queue.

### Create a fresh Jellyfin backup before nightly import

Starting with **0.22.0**, enable **Create a fresh Jellyfin backup before each
scheduled import** in the Jellyfin daily schedule, then save it. The scheduled
time becomes the start of **backup creation → completed archive import**. Existing
installations default to import-only. Both containers must use the updated image;
there are **no additional mounts, credentials or environment variables**.

The web app uses its saved administrator API key to request Jellyfin's native
backup API with database enabled and metadata, subtitles and trickplay disabled.
Jellyfin also includes configuration and supporting files in this native archive.
The helper keeps its read-only backup mount and receives only the completed
archive's safe filename and original timestamp, never the API key. Manual
**Import latest Jellyfin backup** remains import-only.

Jellyfin does the live database work, including database optimization. Its native
backup is supported while the server is running, but can consume CPU, I/O and
hold database transactions; this is not a guarantee of uninterrupted playback.
Jellyport checks for an active library scan before requesting a backup and skips
that occurrence if one is running. Choose a time outside the library-scan window,
and avoid starting another backup manually while Jellyport is preparing one.
Changing or disabling the schedule does not cancel already accepted server work.

Backup preparation has a separate **30-minute observation window**; the completed
archive then gets the existing five-minute import limit. The UI distinguishes
creation, waiting for completion, and import. The original archive timestamp
continues to determine expiry. A failed or missing new archive never causes an
older backup to be imported as a successful fresh backup.

Jellyfin supplies neither a backup job ID nor a cancellation/idempotency API.
Jellyport saves its intent before the POST and never automatically repeats that
POST after a timeout, network error or application restart. It reconciles through
read-only completed-backup observations. A unique new archive matching the bound
server/version and request time can continue the import; an ambiguous result or
unconfirmed completion retains the last good catalog and blocks new imports.
Late completion can still be recovered without another creation request.

If completion remains uncertain, inspect **Jellyfin → Dashboard → Backups** first.
Use **Confirm backup stopped…** only after confirming the backup finished or
stopped. The confirmation is bound to that specific attempt, rechecks Jellyfin,
and cannot override a changed server identity, unavailable helper or ambiguous
result. It neither cancels server work nor deletes backups. A rotated API key can
reconcile the same verified server; a changed server URL/identity requires restoring
the original connection. Successful confirmation with no new archive releases the
attempt for the next scheduled date without replaying today's creation request.

The native API currently has no archive deletion or retention endpoint. Jellyport
retains its existing catalog cleanup rules and does not delete raw Jellyfin ZIPs.
Apply a suitable retention policy to the server's backup directory separately.
The native service requires free space before starting, but that is not retention.

API behavior is verified against the official [backup controller](https://github.com/jellyfin/jellyfin/blob/ca0f16eb7c195f720a1493ed469a27c4657db0c6/Jellyfin.Api/Controllers/BackupController.cs)
and [backup service](https://github.com/jellyfin/jellyfin/blob/ca0f16eb7c195f720a1493ed469a27c4657db0c6/Jellyfin.Server.Implementations/FullSystemBackup/BackupService.cs).
The [Jellyfin backup guide](https://jellyfin.org/docs/general/administration/backup-and-restore/)
describes native backup contents and live-server limitations. Unsupported servers
or insufficient API-key permissions report a failed attempt without an import.

Timing rules are the same for both import schedules:

- Settings and automatic-attempt claims survive application restarts. An active
  saved request resumes result checking; preparation interrupted before a request
  was saved reports **Interrupted** and is not silently replayed.
- An unattempted occurrence may catch up for less than one hour after its scheduled
  time, including across midnight. Older missed runs are skipped, without a backlog.
  If another import occupies the slot for that entire window, the next automatic
  opportunity is the next scheduled date.
- A spring-forward time that does not exist is skipped that day. A fall-back time
  that occurs twice uses its first occurrence, at most once for that civil date.
- Automatic claims only move forward by civil date. Moving the clock/time zone or
  editing the time backwards cannot reopen an already attempted date. The next
  run waits for a date later than the last claimed date in the selected zone.
- A manual attempt within, or spanning, the due window satisfies that automatic
  occurrence. Administrators can still explicitly import manually more than once.
  Failed automatic attempts remain visible and wait for the next date; inspect
  status and fix the reported problem before manually retrying.

Starting an import is an acknowledgement, not a successful completion. Follow its
running status until the outcome is shown. If a request or status refresh fails,
refresh status to reconcile what actually happened before retrying. A failed new
import preserves any previously validated catalog, which may already be expired;
a failed first import does not create a usable catalog. Original backup time
controls the 48-hour freshness limit. If it expires, create a fresh completed
database backup in Jellyfin, then import it. Reimporting unchanged old content or
enabling a daily import schedule cannot refresh its age.

The helper checks the manifest's original age, future timestamp and linked server
version before creating the projection or reading the large catalog tables. A
timestamp more than one minute in the future is rejected. Freshness and file
integrity are checked again before publishing the completed catalog.

Current helpers report the attempt's elapsed time, current or last observed stage,
aggregate row/item/key counts and processed bytes. Stages distinguish backup
validation, reading items and providers, enriching data, indexing, integrity checks,
encryption and final validation. Failure reasons identify expired or missing
backups, incompatible or changed files, storage problems, interruption and timeout.
The saved catalog's import duration belongs to that earlier successful catalog;
it is separate from the latest attempt's duration. Missing progress from an older
helper is shown without inventing counts or a completion percentage. Diagnostics
contain no private paths, item identities, credentials or playback details.

The initial adapter supports the inspected **Jellyfin 12.2.0.0 / backup engine
0.2.0** schema only. Other versions fail explicitly until their format is verified.
The importer selects the newest canonical filename and rejects an incomplete or
invalid newest archive rather than silently using an older one.

After upgrading to 0.16.3, import the matching backup once again, even if the archive
has not changed. Projection v2 adds neutral physical-root/library associations used
with fresh destination permissions. The new format replaces the older projection
of that same archive without renewing its original date. V1 projections remain
readable, but large migrations without membership hints can exceed the bounded
individual-access check limit and require this reimport. An outdated helper cannot
replace a v2 projection with an older format.

## Repeatable migration and measurement

1. Complete both backups and import the Emby source history and Jellyfin matching
   catalog. Record their original dates and shared import durations separately.
   Create and import fresh backups after library changes or before the 48-hour age
   limit expires.
2. Preview a user or batch with saved Emby history, inspect account identities and
   mappings, then approve. Preview is lightweight; detailed matching is deferred.
   Approval pins the current destination catalog across that job.
3. Wait for played-state updates and independent played-state readback to finish.
   Inspect per-user unmatched, ambiguous, failed and verification counts.
   A **partial** migration is not complete, even if all HTTP requests succeeded.
4. Record combined review-build plus accepted-job time, each account's timing and
   phase breakdown, shared preprocessing and bulk wall time. Human review wait is
   excluded; queue/provisioning, live writes and readback remain included. Under two
   minutes is the target; two to five is partial performance success. Report users
   exceeding five minutes individually. Test writes only with authorization and
   safe users or recoverable backups. Local fake-target results are not acceptance
   evidence for a production server.

## Integrity, privacy and limitations

Only `manifest.json`, `Database/BaseItems.json` and
`Database/BaseItemProviders.json` are decompressed. Selected streams have bounded
sizes, row depth, field sizes, CRC and declared-length validation. IDs must be
unique; provider relationships and supported media types are checked. JSON strings
remain unpacked and are processed in fixed batches of 256 tokens with bounded
stream backpressure; existing row/field limits are unchanged. Catalog/index
storage is disk-backed. The archive must remain a
regular, unchanged file through import and fingerprinting. No raw archive entries
are extracted to paths, and no authentication/user-history tables are parsed.
The projection contains only allowlisted matching metadata, names, runtime and
neutral library/root associations; it is encrypted in the shared directory and temporarily decrypted only in
private application storage. Protect exchange, work and application directories.

This archive manifest lacks a server ID. The administrator's trusted read-only
mount supplies provenance; the requested import is bound to the linked server's
fresh API ID, URL and version. Before use, every candidate is checked through the
actual user's API access and matching identity. Archive metadata cannot authorize
an account, grant library access or bypass fresh state checks. Reusing an archive
from another server is unsupported even if versions match.

Backup creation and later library changes are not one atomic operation with live
migration. New items are absent until another backup, and metadata edits can make
fresh identity validation fail. A pinned backup cannot renew itself, and failure
never switches automatically to a live crawl. Import failures preserve any last
good generation; reimporting unchanged content does not renew its age. Clearing is
refused while imports or jobs pin data. Retention keeps the latest two generations
and active job pins, with at most eight; idle decrypted generations are removed.
An expired record requires a new backup/import, not a relaxed age limit.
Changed live library/location configuration also requires a new matching backup;
fresh fingerprints are checked before trusting saved access hints and again during
verification, so old already-played flags cannot silently count as accessible.

Limits: 8 GiB archive and projection, two million supported projected items,
200,000 candidates / 64 MiB per account, five-minute worker deadline. The helper's
CPU/memory limits also apply. Reserve private work/exchange space for projection,
index construction, encryption and temporary reads. Validation errors remain
sanitized; no credentials, item identities or personal playback data enter logs.
Unknown or apparently denied access checks are limited to 2,048 IDs, four read-only
workers and 60 seconds per phase. The normal known-access path remains batched;
there is no automatic per-item scan of a large legacy catalog.
