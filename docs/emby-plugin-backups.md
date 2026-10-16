# Emby Backup & Restore history imports — 0.14.0

Jellyport imports saved history from the **full-backup layout** produced by Emby
Server **4.10.1.0** with Backup & Restore **1.8.7.0**. Both the web app and isolated
helper must run Jellyport **0.14.0 or later**. Other versions and dated database-only
folders are rejected until their format and source binding are verified.

## Configure Emby and the helper

1. Emby's plugin requires a validated **Emby Premiere** subscription. Install it
   through Emby's plugin catalog and configure an absolute backup folder writable
   by Emby's container user. Configure its **Emby Server Backup** scheduled task.
   Jellyport does not start, stop or reschedule that task. See the
   [official setup guide](https://emby.media/support/articles/Backup-Using-Plugin.html).
2. Use [compose.plugin-backups.yaml](../examples/compose.plugin-backups.yaml).
   Set `JELLYPORT_SNAPSHOT_METHOD=plugin_backup` and
   `JELLYPORT_EMBY_BACKUP_DIR=/emby-backups` on the helper. Bind the Docker host's
   **backup root** read-only at `/emby-backups`; it must contain
   `embyserver-backup-full/backupinfo.json` and that folder's `data/library.db`,
   `data/users.db` and `data/device.txt`. A laptop's mounted-share path is not the
   Docker host's path. Do not substitute a live database mount.
3. Keep `/work` helper-only and private. Share only the separate `/snapshots`
   exchange with Jellyport, and preserve the existing Jellyport `/data` mount.
   The helper needs no network and opens only copied private SQLite databases.
4. In **Settings → Saved Emby database snapshots**, confirm **Emby plugin backup**,
   then choose **Import latest backup**. The existing daily schedule becomes an
   import schedule. Run it after the Emby task finishes, leaving at least five
   minutes after the last backup-file write. It does not create a second backup.
5. Plugin-backed migrations default to saved history. If the history source is
   unknown, choose it explicitly before previewing; missing or expired saved data
   stops the preview without switching to live history. Check the original backup
   date and warnings before starting. Accounts added after the backup are absent
   until a newer backup includes them; other backed-up users remain usable.

## Validation and freshness

The importer reads a fixed allowlist only. It checks the known manifest version,
`CanRestore`, full-backup flag, original date, embedded server ID and exact user
identity set. Files must be regular, settled and unchanged before/open/after the
copy; manifest and identity bytes are rechecked. Symlinks, database sidecars,
changes, unsupported schemas and corruption fail without replacing saved history.
SQLite integrity checks, schema validation and projection run on private copies.
Copied-byte fingerprints identify unchanged generations. Authentication databases,
configuration, artwork and raw user account records are never published.

History expires **48 hours after the backup's original date**, with one minute of
future-clock tolerance. Import times are displayed separately. Reimporting the
same fingerprint does not add a generation or renew its history age. A newer
plugin generation cannot be replaced by an older one for the same server.
Explicitly switching from live capture to plugin backup may select older saved
history within that limit; Jellyfin's newer activity remains protected by merge.
Failures keep the last valid generation, without falling back to live catalog
reads. At most eight generations may be retained, including pinned jobs/previews.

The full-backup folder is refreshed in place. Emby does not document an atomic
completion marker. `CanRestore`, five-minute settling, unchanged bytes/statistics
and integrity checks provide validation evidence, **not proof of a transactionally
atomic backup or zero missing recent activity**. Schedule imports after a successful
plugin task. The helper has a five-minute worker deadline, an 8 GiB combined input
limit and a separate private work area; reserve room for raw copies and projection.
Backup creation itself still consumes Emby resources; it was not load-tested here.

## History fields and limitations

The verified database layout includes played flags and matching metadata (provider
IDs, series/episode numbering and paths). It can also contain counts, dates,
favorites, resume ticks and ratings. Jellyport migrates **played flags only**; those
other fields are not transferred. Existing broader encrypted projections remain
readable for compatibility. Mid-episode and mid-movie positions are not supported.
An unplayed source never clears a Jellyfin played flag or any unrelated personal
state.

Supported upgraded column declarations and composite unique indexes are validated
without arbitrary schema coercion. Invalid display names are omitted and reported
while identity metadata remains unchanged. Unsupported item types and orphan state
with no current catalog identity produce aggregate diagnostics instead of guessing
a target. Deleted media cannot be reliably matched from a bare user-data key.
Collection IDs named `Tmdb` and `TmdbCollection` are normalized only within the
collection type, preserving contradictory-ID checks.

This is a played-state import, not a full server restore. Current source identity,
destination access and Jellyfin activity remain live. Emby preferences, images and
playlists are not read or transferred. Plugin-owned reporting databases, credentials
and full playback-event ledgers are outside this adapter. New-account defaults
still come from the configured Jellyfin role/template. See
[migration capabilities](migration-capabilities.md).

Local simulations use private backup copies and fake destination clients. Only
synthetic regression fixtures enter the repository; no backup, account identity,
media name/path, playback value or credential is committed or sent to a live target.
