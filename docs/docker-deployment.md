# Docker and Portainer deployment

Jellyport runs its web interface, API, and optional Discord bot in one container. The default deployment connects to Emby and Jellyfin through their APIs and needs only its own data directory. An optional, separate snapshot helper can read Emby's local databases to prepare migration history without repeated full-library API scans. Keep media libraries and media-server configuration directories out of the web container.

## Choose an example

- [Standalone Portainer stack](../examples/compose.portainer.yaml): use reachable hostnames or server addresses in the setup wizard and Settings.
- [Stack on an existing Docker network](../examples/compose.shared-network.yaml): connect Jellyport to the network used by your media servers or reverse proxy.
- [Optional Emby snapshot helper](../examples/compose.snapshots.yaml): run beside Emby on the same Linux Docker host, using a read-only local database mount in a network-isolated helper.
- [Repository Compose file](../compose.yaml): build from source and retain the original `jellyport-data` named volume. This uses the image's default UID/GID `10001:10001` and publishes the web port on the host's loopback address.

The Portainer examples use a published image, list-style environment variables, and a dedicated host bind mount. Replace their generic paths and settings before deploying. These examples target Docker Standalone; run one Jellyport container against each data directory.

## Prepare the data directory

On the Linux Docker host, create a dedicated directory owned by the user and group that will run Jellyport:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /path/to/jellyport
```

Use the actual host path in the Compose volume entry. On a NAS shell already running as root, omit `sudo`. The `user: "1000:1000"` entry sets the container process's UID and GID directly; change it and the directory ownership together if your host uses different IDs. Jellyport does not interpret `PUID` or `PGID` environment variables. Docker documents the [Compose user setting](https://docs.docker.com/reference/compose-file/services/#user) and [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

Jellyport pairs with a pre-created Jellyfin API key; ordinary sign-in uses your Jellyfin administrator account. Enter the key in the web wizard, without adding it or an administrator password to Compose or Portainer's environment variables. Use `TZ=Etc/UTC` or another valid timezone in the container environment; no localtime mount is required.

## Optional local Emby snapshots — 0.12.0

Use [compose.snapshots.yaml](../examples/compose.snapshots.yaml) when repeated live Emby catalog scans are too expensive. The example opts into `JELLYPORT_SNAPSHOT_METHOD=file_copy`: ordinary best-effort copies of `library.db`, `users.db` and their available `-wal` files, made while Emby runs. No ZFS, downtime, backup plugin or special storage is required. The helper makes no source SQLite queries in this mode, excludes `-shm` and authentication databases, and performs normal WAL recovery plus integrity/schema validation on its private copies. It then builds and encrypts an allowlisted migration projection; only that projection reaches Jellyport. This is not a full Emby restoration backup. Capture still consumes disk bandwidth and CPU.

Live-file copies are not atomic. A structurally valid copy can omit recent changes or combine files collected at different moments; passing integrity checks cannot establish semantic completeness. Unsupported, damaged or unresolvable copies fail without replacing the last good projection. Jellyport does not run `.recover` or adopt salvaged/repaired data. Omitting `JELLYPORT_SNAPSHOT_METHOD` preserves the legacy `sqlite_online_backup` method; set that value explicitly to select it. The existing daily schedule works with either configured helper method.

Deploy both services on the same Linux Docker host as Emby, with the same Jellyport image version and UID/GID. Set the helper's source path to the local directory containing `library.db`, `users.db`, `device.txt`, `lastversion.txt`, and the SQLite sidecars. The helper checks the mounted server identity and version before and after capture against the configured Emby API connection. This path belongs to the Docker host, not a laptop's mounted share; keep it on the local filesystem rather than SMB/NFS. Mount the whole small database directory read-only so replacing WAL files does not leave an individual file mount pointing at an obsolete file. The helper's file-copy mode deliberately accepts best-effort live copies and validates only the resulting private databases; a manually copied arbitrary database is not an automatically trusted published snapshot. [SQLite WAL requirements](https://sqlite.org/wal.html), [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

Prepare separate private exchange and helper work directories alongside the existing application directory:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /path/to/jellyport-snapshots
sudo install -d -m 700 -o 1000 -g 1000 /path/to/jellyport-snapshot-work
```

Both services mount that exchange directory at `/snapshots` and set `JELLYPORT_SNAPSHOT_DIR=/snapshots`. Only the helper mounts the separate work directory at `/work` and sets `JELLYPORT_SNAPSHOT_WORK_DIR=/work`; never mount it in the web container or reuse `/snapshots` or `/data` for it. The helper also receives `JELLYPORT_EMBY_DATA_DIR=/emby-data` and the read-only Emby database-directory mount. Set `JELLYPORT_SNAPSHOT_METHOD=file_copy` in the helper's environment to select ordinary file copies; do not set it on the web service as a substitute. Set `JELLYPORT_EMBY_VERSION` to the adapter-supported server version; the initial adapter targets **4.10.1.0** and rejects an unrecognized schema. Grant the helper's configured UID/GID read access to the databases and existing WAL files; do not make the source directory world-readable or writable. Keep the existing Jellyport `/data` mount unchanged, and do not give the helper that mount. Its writable work mount is required with the read-only container filesystem.

The helper has no network, published ports, HTTP API, Docker socket, or media-server API keys. It receives fixed capture requests through the private exchange directory. Raw databases/WAL files and the temporary projection are created only under the helper's private `/work` mount and removed after use. A raw `users.db` copy can contain private account configuration or credential material: it never reaches the exchange or web container. Only the required user ID/GUID mapping is derived from it. The published encrypted projection excludes unrelated native tables such as sync jobs and targets, unused columns, and arbitrary metadata payloads. `authentication.db`, `-shm` and unrelated Emby configuration files are not copied. The helper can still read other files permitted by its source-directory mount, so use the smallest actual database directory and keep it isolated from the web container. The exchange contains the encrypted migration projection and its encryption material, and Jellyport temporarily decrypts only that projection for authenticated migration reads. Protect all three private directories as carefully as `/data`. [Docker network isolation](https://docs.docker.com/reference/compose-file/services/#network_mode)

The example disables the image's HTTP health check for the helper because it has no web listener. Snapshot status appears in Jellyport. Its CPU and memory limits can be adjusted for the database size and host; an exhausted limit can cause a capture to fail. The existing last good snapshot is retained on failure. Never fix a read-only/WAL access error by enabling source writes, `immutable=1`, disabled locking, forced checkpoints, or journal-mode changes on the live database. [SQLite immutable-file caveat](https://sqlite.org/uri.html#uriimmutable)

In Jellyport, open the source snapshot settings, capture a snapshot, and optionally enable its daily schedule with an explicit timezone. Scheduling and snapshot use are disabled by default. Select saved snapshots when reviewing a migration; approval pins the exact generations shown. Snapshots expire after 48 hours. A missing, expired, incompatible, or changed selection requires another capture and review instead of silently falling back to a live scan. Clearing snapshots is refused while capture or a job that needs them is active. See [snapshot data and limitations](migration-capabilities.md#saved-emby-source-snapshots--0120).

File-copy capture does not open a source SQLite connection or pin a source read transaction. Its private-copy recovery can discard an uncommitted/incomplete WAL tail as part of normal SQLite behavior; the result remains best effort. The legacy Online Backup method pins a consistent `library.db` read transaction: WAL writers can continue, but checkpoint/reset can be delayed and WAL size can grow until it closes. Both methods have a five-minute worker deadline. The projection preserves migration fields only. User identity comes from a separate database and Complete-mode extras are live API reads, so neither method makes the whole migration one transaction across databases and APIs. A busy, inaccessible or unsupported source retains the last good copy, with no automatic live-history fallback. File-copy mode limits the combined source databases/WAL files to 8 GiB; Online Backup limits the source library database to 8 GiB. Published projections are also limited to 8 GiB. Retention keeps the two most recent projections and any preview/job pins, with at most eight generations; reserve work-directory space for raw databases, copied WAL files and the projection, plus exchange space for temporary decryption. Status and preview identify `source_type: file_copy` for best-effort copies; older records without a method retain Online Backup semantics. [SQLite backup API](https://sqlite.org/c3ref/backup_finish.html), [WAL concurrency](https://sqlite.org/wal.html#concurrency)

## Configure image access in Portainer

The examples use the public image `ghcr.io/cruv/jellyport:latest`. Portainer can pull it without GitHub credentials or a registry login. It supports Linux x86-64 and ARM64. Each publication follows successful CI and smoke tests on both architectures.

For a privately published fork, add a **Custom registry** in Portainer with URL `ghcr.io` and authentication enabled. Use your GitHub username and a personal access token **classic** with `read:packages` from an account that can access that package. Store the token in the registry configuration, rather than Compose. Fine-grained tokens do not support registry authentication. See [Portainer's Custom registry instructions](https://docs.portainer.io/admin/registries/add/custom) and [GitHub's Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

Create a stack using the selected example and deploy it. For later image updates, use Portainer's stack update option to pull the image again and recreate the container, retaining the same data mount.

Version 0.7.0 upgrades existing identity links and mappings to primary account slot 1 automatically. Keep the existing data directory; no new environment variables are needed. Extra accounts are created only when you apply a membership tier or opt into recognized subscription automation. Keep a stopped, complete backup of the database and `secret.key` before this schema upgrade. Rolling back to an older image requires restoring its matching pre-upgrade data backup.

## Complete first-run setup

Sign in to Jellyfin as an administrator and create a dedicated key under **Dashboard → Advanced → API Keys**. Label it `Jellyport` for easy identification; any key name is accepted. Open Jellyport using its private LAN IP, local hostname, or localhost, and enter the Jellyfin server URL and paste that key in the setup wizard. Set the public Jellyfin URL that your users should receive; selecting an existing enabled, non-administrator legacy template user is optional. The wizard can finish without one. After completing setup, add the Emby source URL and API key in Settings. Pairing requires both a private/loopback connection source and a local Host header. Complete setup before exposing a reverse proxy; the first qualifying visitor can link the server. A permitted public proxy hostname cannot perform first pairing, even when the proxy connects from a private address. For loopback-only deployments, use a local browser or SSH tunnel.

For an HTTPS deployment, set `JELLYPORT_SECURE_COOKIE=true` and your `JELLYPORT_ALLOWED_HOSTS` before starting Jellyport. Local HTTP setup uses a separate setup-only HttpOnly, SameSite Strict cookie and works with secure cookies already enabled. When pairing finishes, Jellyport clears that cookie and returns to sign-in. Open your HTTPS reverse-proxy address to sign in; changing the variable to `false` and restarting for setup is unnecessary. The setup cookie never authorizes an administrator session. Use a trusted local connection or encrypted VPN for pairing: HTTP still exposes the API key to anyone able to observe that connection.

Jellyport validates the supplied API key and server identity. The pending key stays in server memory until you finish setup; the saved pairing and key are encrypted in `/data`. The key is never returned in browser responses or stored in localStorage or sessionStorage. Jellyport does not create, delete, or revoke API keys. Completing setup returns you to sign-in: use an enabled administrator account on the linked Jellyfin server with a nonempty password. Jellyport does not retain that password. Jellyfin must be reachable for sign-in and authorization checks.

When upgrading from shared-password sign-in, complete the wizard with a pre-created Jellyfin API key, then sign in with your Jellyfin administrator account. The wizard keeps an existing saved Jellyfin server address fixed. Remove the obsolete `JELLYPORT_ADMIN_PASSWORD` variable from the service configuration and Portainer's stack variables; it is ignored. Preserve the existing data directory when upgrading. Installations already paired with Jellyfin keep their existing API key and normal Jellyfin sign-in. Switching to manual key setup does not require resetting pairing or deleting any data.

## Choose account defaults

Before creating or migrating accounts, configure a default account role or an optional legacy template in Jellyport Settings. These are application settings; no additional Compose environment variables are required.

Use **Account roles** to copy supported permissions, account preferences, and shared server-backed Home/display settings from an enabled, non-administrator Jellyfin account into a new or existing saved role. Compatible TV/mobile apps also use those shared Home settings. Save the snapshot, then select it as the default in Settings. A saved role is encrypted and scoped to the paired Jellyfin server; the original source account is no longer required. Roles and assignments are retained in the existing `/data` directory on upgrade, so keep the database and matching `secret.key` together.

The default role affects future accounts and takes precedence over a selected legacy template and portable Emby preferences. It does not automatically reconfigure existing accounts. Use the separate assign/review/apply workflow to update chosen groups for up to 100 existing users. Client-local TV/mobile preferences cannot be configured universally. See [account roles and defaults](../README.md#account-roles-and-defaults) for details.

## Web access and server URLs

The examples publish `8000:8000`; the left number is the host port and can be changed to an unused port. Open `http://YOUR_SERVER_ADDRESS:8000` for the HTTP configuration. It publishes on the host's interfaces, so choose the binding appropriate to your network. The repository Compose file uses `127.0.0.1:8000:8000` for local access or a host reverse proxy.

Route your HTTPS reverse proxy to Jellyport's container port `8000`, set `JELLYPORT_SECURE_COOKIE=true`, and add its hostname to `JELLYPORT_ALLOWED_HOSTS`. These variables may be configured before initial deployment. If changing them on an existing installation, recreate the container while retaining its data mount. For example, set `JELLYPORT_ALLOWED_HOSTS=jellyport.example.com` in Portainer's stack environment variables. Use comma-separated hostnames without schemes, ports, paths, or wildcards. IP literals, single-label names, `.local`, `.localhost`, and `.home.arpa` names are permitted by default; other DNS names require this setting.

Preserve the original Host header, including a nondefault browser port. Jellyport compares browser Origin headers against it and rejects cross-site API requests. Do not expose first-run setup through a proxy that rewrites a public hostname into a local one. Forwarded IP headers are not trusted; proxy clients share its peer address for rate limits. Keep the raw application port private. Set `JELLYPORT_SECURE_COOKIE` according to the browser connection: `true` for HTTPS, including a proxy with an HTTP upstream; `false` for HTTP-only access. A reverse proxy alone does not require `true`. Browsers normally withhold Secure cookies over HTTP; localhost has a browser exception, so it is not a substitute for testing your actual HTTPS address. The separate local setup cookie allows pairing before HTTPS sign-in. See [MDN's Secure cookie behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#secure).

HTTP alone does not encrypt API keys, administrator passwords, or session cookies; use HTTPS or an encrypted VPN for confidential access. Serve the app at the root of its host or subdomain. A proxy container must be able to reach Jellyport, typically through a shared Docker network. See [the security review](security-review.md) for the data and trust model.

Enter the Jellyfin URL in the setup wizard and the Emby URL and API key in Settings. With the standalone example, use hostnames or server addresses reachable from inside the Jellyport container, including each server's published port. `localhost` points to Jellyport's own container.

With the shared-network example, set `JELLYPORT_MEDIA_NETWORK` in Portainer's stack environment to the existing network's **actual Docker name**. Check Portainer's Networks page or `docker network ls`; Compose-created names often have a project or stack prefix. The `external: true` setting tells Compose to use that existing network, as described in [Docker's network reference](https://docs.docker.com/reference/compose-file/networks/#external).

Containers on the same network can use service names and internal ports. For example, a service named `jellyfin` listening on port `8096` is reachable at `http://jellyfin:8096`, regardless of its published host port. The public Jellyfin URL in Settings is separate: it must be a URL your users can open.

To add Jellyport to the **same** Compose stack as your media servers, copy its `jellyport:` service block under the existing `services:` section and attach it to that stack's existing network key:

```yaml
services:
  # Existing media services remain here.
  jellyport:
    # Copy the rest of the Jellyport service configuration here.
    networks:
      - media-network
```

Keep the existing stack's top-level network definition. Do not replace it with `external: true` merely to add Jellyport to the same stack; the external-network example is for a separate stack joining a network created elsewhere.

## Troubleshooting startup

If first-run setup previously failed with `JELLYPORT_SECURE_COOKIE=true` over a LAN HTTP address, update the image and retry the wizard with that setting retained. Local pairing now uses its own setup cookie. Once pairing is complete, use the configured HTTPS address for administrator sign-in. An existing HTTP-only deployment must use `false` for ordinary login. Keep the existing data directory; a pairing reset is unnecessary for this cookie mismatch.

If the setup page reports an unreachable server, confirm that the Jellyfin URL is reachable from the container and includes the correct port and any reverse-proxy base path. Jellyfin sign-in requires an enabled administrator account. The Jellyfin service key is separate from sign-in; if it is revoked or needs replacing, create a new key in Jellyfin's **Dashboard → Advanced → API Keys**, sign in to Jellyport as a Jellyfin administrator, and paste the new key into the API-key replacement field in Settings. Replacement keeps the previous key available for already queued jobs. Wait until those jobs finish before manually revoking the obsolete key in Jellyfin; earlier revocation can interrupt them.

For a permission-denied startup message, check that the mounted directory and its existing database, journal files, and `secret.key` are owned by the configured container user and group. The bind-mount examples use `1000:1000`; the default named-volume deployment uses `10001:10001`.

Bind-mount source paths refer to the Docker host. A directory reached through a mounted NAS share on a laptop can have a different path and displayed owner from that same directory on the server. Check the server-side path and permissions. If moving Jellyport into another stack, verify that its volume entry still points to the intended data directory.

For **502 Bad Gateway** while opening a migration review, large-catalog matching now runs in the background with short progress polls. A generic gateway page points to a different layer than a sanitized Jellyport JSON error. Check container health and proxy connectivity, then follow [migration review troubleshooting](migration-capabilities.md#troubleshooting-a-migration-review). The preview is read-only; a failed or cancelled review does not change media accounts.

## Reset Jellyfin pairing

For local recovery, stop Jellyport and run the reset command against the same data mount and image. Recovery retains the linked Jellyfin server's address and verifies its identity. To link a different Jellyfin server, start a fresh Jellyport installation with a new data directory; existing account links and jobs belong to the original server.

With the repository Compose file:

```sh
docker compose stop jellyport
docker compose run --rm --no-deps jellyport node dist/server/reset-auth.js
docker compose up -d jellyport
```

The command confirms that authentication was reset. Open Jellyport and complete the wizard again using a valid API key for the same Jellyfin server, then sign in with your Jellyfin administrator account. The reset does not revoke keys on Jellyfin.

If the same Jellyfin server has moved to a new address, add `--server-url http://NEW_JELLYFIN_ADDRESS:8096` after `reset-auth.js` in the reset command. This changes the address used by the wizard while still requiring the original Jellyfin server's identity. Without this option, recovery keeps the previous address fixed.

For a Portainer bind-mount deployment, stop the container in Portainer, then run the equivalent command on the Docker host with its actual data directory and configured UID/GID:

```sh
docker run --rm --user 1000:1000 \
  -e JELLYPORT_DATA_DIR=/data \
  -v /path/to/jellyport:/data \
  ghcr.io/cruv/jellyport:latest node dist/server/reset-auth.js
```

Use the same image version as the stopped container, then start Jellyport in Portainer and complete setup with a valid API key for the same Jellyfin server, followed by your Jellyfin administrator sign-in. Reset preserves server settings, account links, jobs, history, and `secret.key`; it requires setup again against the same Jellyfin server. Keep the app stopped throughout the reset, and never delete the database or encryption key to recover a login.

## Existing installations and backups

The repository Compose file continues to mount the `jellyport-data` named volume and use UID/GID `10001:10001`. Preserve its Compose project name and volume when updating it from source:

```sh
docker compose up -d --build
```

Switching to a Portainer bind-mount example changes the storage location. An empty host folder creates a fresh installation; it does not discover data in the old named volume. Stop the old container first, back up its data, and copy the contents into the new dedicated folder before starting the replacement. Adjust the copied folder and files to the UID/GID configured by the new `user:` entry. For an existing source deployment, copying the stopped service's data to a new backup destination looks like this:

```sh
docker compose stop jellyport
docker compose cp jellyport:/data ./jellyport-backup
```

Check that the destination contains `jellyport.db` and `secret.key`. If moving that backup into a dedicated bind directory for UID/GID `1000:1000`, set ownership and directory permissions before deployment:

```sh
sudo chown -R 1000:1000 /path/to/jellyport
sudo chmod 700 /path/to/jellyport
```

For bind-mount deployments, stop Jellyport in Portainer and copy the complete host data directory to a new backup location. Restore the database and `secret.key` from the same backup while the service is stopped; retain any SQLite journal files present in the stopped backup. The key is required to decrypt saved server credentials and the Jellyfin pairing. Protect the backup as you would the live data directory. Start only one container against the restored data.
