# Saved Jellyfin matching catalog — 0.15.0

For a large library, use a completed native Jellyfin backup for item matching
alongside the [Emby plugin backup](emby-plugin-backups.md) for source history.
This avoids the live destination catalog traversal and its OFFSET/sort behavior.
It does not restore a database or import Jellyfin users, passwords or saved history.
Fresh destination account access and playback activity remain authoritative.

## Setup

1. In Jellyfin's admin dashboard, create a **database-only backup**. Metadata,
   subtitles and trickplay are unnecessary. Wait until Jellyfin reports completion.
   Creating this backup can consume server resources; Jellyport does not trigger
   backups or schedule them on the media server.
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
4. In Jellyport Settings, use **Jellyfin matching backup → Import latest backup**.
   Review its original backup date, expiry and item count. An unavailable helper
   prevents new imports; an already valid imported catalog can still serve jobs.

The initial adapter supports the inspected **Jellyfin 12.2.0.0 / backup engine
0.2.0** schema only. Other versions fail explicitly until their format is verified.
The importer selects the newest canonical filename and rejects an incomplete or
invalid newest archive rather than silently using an older one.

## Repeatable migration and measurement

1. Complete both backups and import the Emby source history and Jellyfin matching
   catalog. Record their original dates and shared import durations separately.
   Reimport after library changes or before the 48-hour age limit expires.
2. Preview a user or batch with saved Emby history, inspect account identities and
   mappings, then approve. Preview is lightweight; detailed matching is deferred.
   Approval pins the current destination catalog across that job.
3. Wait for history updates, independent history readback and playlist verification
   to finish. Inspect per-user unmatched, ambiguous, failed and verification counts.
   A **partial** migration is not complete, even if all HTTP requests succeeded.
4. Record total job elapsed time, each account's timing and phase breakdown, shared
   preprocessing time and bulk wall time. For one user, total job time includes
   queue/provisioning overhead. Report users exceeding five minutes individually;
   the goal is two minutes where practical. Test writes only with authorization and
   safe users or recoverable backups. Local fake-target results are not acceptance
   evidence for a production server.

## Integrity, privacy and limitations

Only `manifest.json`, `Database/BaseItems.json` and
`Database/BaseItemProviders.json` are decompressed. Selected streams have bounded
sizes, row depth, field sizes, CRC and declared-length validation. IDs must be
unique; provider relationships and supported media types are checked. JSON strings
are streamed and catalog/index storage is disk-backed. The archive must remain a
regular, unchanged file through import and fingerprinting. No raw archive entries
are extracted to paths, and no authentication/user-history tables are parsed.
The projection contains only matching metadata, names and runtime needed for safe
merging; it is encrypted in the shared directory and temporarily decrypted only in
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
never switches automatically to a live crawl. Import failures preserve the last
good generation; reimporting unchanged content does not renew its age. Clearing is
refused while imports or jobs pin data. Retention keeps the latest two generations
and active job pins, with at most eight; idle decrypted generations are removed.
An expired record requires a new backup/import, not a relaxed age limit.

Limits: 8 GiB archive and projection, two million supported projected items,
200,000 candidates / 64 MiB per account, five-minute worker deadline. The helper's
CPU/memory limits also apply. Reserve private work/exchange space for projection,
index construction, encryption and temporary reads. Validation errors remain
sanitized; no credentials, item identities or personal playback data enter logs.
