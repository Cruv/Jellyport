# Jellyport

Jellyport is a self-hosted web app for moving one or several users from Emby to Jellyfin, creating accounts from a Jellyfin template, and optionally delivering new credentials through Discord. It also provides an administrator review queue for MEE6 membership announcements and Discord membership role changes, with optional automatic provisioning and access removal.

This is an initial implementation. Automated tests and the local demo cover the implemented workflows; compatibility has not yet been validated against your live Emby, Jellyfin, or Discord servers.

![Jellyport demo dashboard](docs/jellyport-preview.jpg)

## Run with Docker Compose

From a checkout of this repository:

```sh
cp .env.example .env
```

Set `JELLYPORT_ADMIN_PASSWORD` in `.env` to a long, random password. Startup rejects passwords shorter than 12 characters and the example placeholder. This password grants access to server configuration, account operations, and generated credentials.

```sh
docker compose up -d --build
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) and sign in. Compose binds to `127.0.0.1:8000` by default. For access from another machine, put your HTTPS reverse proxy in front of this address and set `JELLYPORT_SECURE_COOKIE=true` in `.env`, then recreate the container. A proxy in another container needs a route to the host or an explicitly configured shared Docker network.

The container must be able to reach both media servers. A server URL containing `localhost` refers to the Jellyport container itself. Use reachable hostnames or addresses; reverse proxy base paths are supported.

Serve Jellyport at the root of its own host/subdomain. Run one application worker/replica: the job lock and admin sessions are local to that process.

## Configure your servers

In Settings, enter:

1. Your Emby server URL and API key with access to its users and their library data.
2. Your Jellyfin server URL and API key with administrative rights to manage users and watched status.
3. The public Jellyfin URL users should receive in their credential message.
4. Your existing Jellyfin template user. It must be enabled and must not be an administrator. New accounts receive its user policy and configuration, including library permissions.

Save the settings and test the connections. Emby is used as a read-only source. Discord and all automatic actions are disabled by default; the web app can operate without a bot.

If the same media files have different mount paths on the two servers, configure source-to-target path prefix mappings. For example, the settings API accepts:

```json
{"path_mappings": [{"source": "/mnt/media", "target": "/media"}]}
```

API keys and the Discord bot token are encrypted in the application database. Leaving a saved secret's input blank preserves its current value.

## Migrate users

Select 1–100 distinct Emby users, review the preview, and start the migration. Destination usernames must match the Emby usernames exactly, including letter case. Case-only conflicts and duplicate destination names require administrator review.

The migration merges watched status for **movies and episodes**. An item marked played in Emby is marked played in Jellyfin when it can be matched confidently. An item already played in Jellyfin remains played, even if Emby marks it unplayed. For a fresh account, the remaining items retain their default unplayed status.

Matching uses provider IDs, series identity with season/episode numbers, and exact file paths with optional prefix mappings. It does not guess from titles. Conflicting metadata and duplicate editions are reported as ambiguous; missing matches are reported as unmatched. Those items are skipped and the job is marked partial so you can review them, correct metadata or mappings, and rerun the merge.

Original play timestamps, play counts, favorites, ratings, resume positions, music, and other user data are not migrated. Marking an item played may create Jellyfin's own current playback metadata; the Emby metadata is not copied.

New destination accounts receive a generated 24-character password and the template's policy and configuration. Ordinary existing Jellyfin accounts keep their passwords and permissions; migration only merges their watched flags. Jellyfin administrators and the template user are protected from migration and account lifecycle actions.

## Create accounts and deliver passwords

Use the account creation form for a new member. With a connected Discord bot, provide the member's numeric Discord user ID and their current Discord username. Jellyport uses the actual username (`member.name`), rather than a server nickname or display name.

For the first Discord link, the account's username must match the member's current Discord username exactly. An Emby user with a different legacy username can still be migrated without selecting a Discord recipient. Verify and resolve that mismatch before linking; Jellyport does not guess ownership or rename accounts automatically.

When a recipient is selected, account provisioning stores the Discord user ID and Jellyfin account ID as a durable link. Membership actions use this link even if the member later changes their Discord username.

New passwords are encrypted and retained for up to 24 hours. After the job finishes, the web app offers a one-time reveal; revealing consumes the stored credential record. Successful Discord delivery removes that record immediately. If delivery fails, credentials remain available for the one-time reveal until expiration. Existing accounts have no new password to reveal or send.

Credential DMs contain the server URL, username, and plaintext password for the selected recipient. Command replies show only private job status. Users can change their password in Jellyfin after signing in.

If a creation times out or stops before initialization finishes, inspect Jellyfin and the recorded job before retrying. The recovery workflow first inspects an exact target account; recovery can reset its password and apply the template only when Jellyport tracks it as an incomplete creation. It preserves watched history and refuses protected or unrelated accounts.

## Optional Discord and membership automation

Follow [Discord setup](docs/discord-setup.md) to configure the bot, command permissions, trusted MEE6 announcement source, and optional membership role events.

```text
/jellyport create user:@jlogan35
/jellyport migrate user:@jlogan35 emby_username:jlogan35
/jellyport status job_id:YOUR_JOB_ID
```

Recognized events appear in the subscription review queue. Apply or ignore them as an administrator. An unresolved username remains for review and cannot automatically change an account; use a verified manual account action instead.

Automatic provisioning and automatic disabling are separate switches, both off by default. Provisioning uses an exact matching Emby account when available, otherwise creates a fresh Jellyfin account. An existing Jellyfin account without a Discord link requires an admin-approved migration before subscription automation can claim it.

Cancellation announcements default to review because cancellation can happen before paid access expires. Role removal or departure is treated as expiry; linked memberships are checked on startup/reconnect and every five minutes when role events are enabled. With automatic provisioning also enabled, reconciliation scans current active-role members for unlinked subscribers, including members who joined during downtime. Enabling this combination can provision all currently eligible unlinked members. Immediate disabling on cancellation is an explicit additional option. Jellyport has no direct MEE6 billing API integration or paid-through date tracking.

Lifecycle actions disable accounts rather than deleting them. Passwords and watched history are preserved. Returning members can regain access to accounts that Jellyport disabled; accounts disabled independently by an administrator are not automatically re-enabled.

## Data and backups

Compose stores application data in the `jellyport-data` named volume mounted at `/data`. It contains `jellyport.db`, SQLite journal files when present, and `secret.key`. Server secrets and retained passwords are encrypted; audit records, usernames, account links, and job summaries are stored as ordinary database records. The encryption key is stored beside the database, so protect the entire volume and its backups.

Stop the service before copying its data, and use a new destination directory for each backup:

```sh
docker compose stop jellyport
docker compose cp jellyport:/data ./jellyport-backup
docker compose start jellyport
```

Restore the database and `secret.key` together while the service is stopped. Without the original key, saved secrets cannot be decrypted. Keep the volume when rebuilding or upgrading. The `.env` admin password is separate from the encrypted volume and should also be kept securely.

Jobs interrupted by a restart are marked interrupted for review; they are not silently resumed. Rerunning a reviewed migration merges remaining watched flags without resetting ordinary existing accounts.

## Development and local demo

Use Python 3.11 or newer:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m pytest
```

For real local operation, set the admin password in `.env` and run:

```sh
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

The demo uses simulated in-memory servers, makes no Emby/Jellyfin/Discord API calls, and keeps settings read-only. Use a separate data directory:

```sh
JELLYPORT_DEMO=true \
JELLYPORT_DATA_DIR=/tmp/jellyport-demo \
JELLYPORT_ADMIN_PASSWORD=demo-jellyport \
JELLYPORT_SECURE_COOKIE=false \
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

Sign in with `demo-jellyport`. Demo server fixtures reset when the process restarts.

## API

The browser uses authenticated session cookies. Mutating API requests require the session's `X-CSRF-Token`; get an anonymous session from `GET /api/session` before calling `POST /api/login`. `/health` is unauthenticated. There is no public subscription webhook endpoint.

| Operation | Endpoint |
| --- | --- |
| Read or update configuration | `GET` / `PUT /api/settings` |
| Test server connections | `POST /api/connections/test` |
| List source and destination users | `GET /api/users` |
| Preview or queue migrations | `POST /api/migrations/preview`, `POST /api/migrations` |
| Create a new account | `POST /api/accounts` |
| Inspect or recover an incomplete creation | `GET /api/accounts/recovery`, `POST /api/accounts/recover` |
| List or inspect jobs | `GET /api/jobs`, `GET /api/jobs/{job_id}` |
| Consume retained credentials | `POST /api/jobs/{job_id}/credentials` |
| Review, apply, or ignore membership events | `GET /api/subscriptions`, `POST /api/subscriptions/{event_id}/apply`, `POST /api/subscriptions/{event_id}/ignore` |

API contracts were checked against [Emby API-key authentication](https://dev.emby.media/doc/restapi/API-Key-Authentication.html), [Emby user items](https://dev.emby.media/reference/RestAPI/ItemsService/getUsersByUseridItems.html), and Jellyfin's [user controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/UserController.cs) and [playstate controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/PlaystateController.cs). Run a migration preview and test one account on your server versions before a bulk migration.
