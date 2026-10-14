# Emby Backup & Restore as a migration source

Emby's official Backup & Restore plugin can produce completed backups for a
future Jellyport importer. **Plugin backup import is not implemented yet.**
Current Jellyport versions and the existing snapshot helper cannot consume
plugin output directly.

## Configure Emby's plugin

1. Validate **Emby Premiere**, install Backup & Restore from Emby's plugin catalog,
   then open **Advanced → Backup & Restore**. If installation requires a restart,
   arrange it separately during maintenance.
2. Choose a dedicated Linux Docker host directory and bind it into Emby. For
   example, host `/path/to/emby-backups` could map to container `/backups`. Enter
   the **absolute container path** `/backups` in the plugin and ensure Emby's
   container user can write there. A macOS-mounted share path is not the Docker
   host path. Adding a mount normally recreates the container; prepare that
   change for maintenance.
3. Leave optional metadata at defaults initially unless needed for full-server
   recovery. Additional metadata increases time and space. Jellyport's minimum
   required selection remains unverified; do not remove required data.
4. Review **Scheduled Tasks → Emby Server Backup**. Emby defaults to daily backups
   and supports a manual run. Set its schedule in Emby; do not enable a second
   live-copy schedule in Jellyport. Observe playback during the first run;
   plugin workload has not been measured here.
5. Record the server/plugin versions, backup paths and successful task completion
   time. A folder appearing or unchanged size does not prove completion. Retain
   that generation for local inspection; do not restore it over the live server.

See [Emby's official setup guide](https://emby.media/support/articles/Backup-Using-Plugin.html).

## What the backup covers

Emby documents core play states, favorites, users, playlists and server settings.
Databases owned by other plugins are excluded, distinct from built-in watched
state. Its restore interface can copy playback state and favorites between Emby
accounts. [Backup coverage](https://emby.media/support/articles/Backup-Using-Plugin.html),
[playback-state restore](https://emby.media/support/articles/Backup-Restore-Playbacks-And-Favorites.html).

Counts, timestamps, resume positions, playlist entries and matching metadata
still need verification in the actual output. History remains as old as its
backup, regardless of import time.

## Protect the backup and validate the importer

Keep sensitive raw backups out of the web container, public shares and
repositories. The planned isolated importer will receive read-only access, use a
private workspace, and publish only a validated encrypted migration projection.
Failure must preserve the last good generation without a live catalog fallback.
Previews must show backup age/provenance and protect newer Jellyfin activity.

Before implementation, verify completion evidence, format/version, server/account
binding and matching/history fields. Enforce size, extraction, memory and time
limits. A future local format inspector could produce sanitized structural
output without uploading a full backup; that tool is not implemented yet.

Next: confirm the Docker host backup path and plugin version, then inspect a
completed generation locally. No plugin-import environment variables or Compose
configuration exist yet.
