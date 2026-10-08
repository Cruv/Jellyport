# Docker and Portainer deployment

Jellyport runs its web interface, API, and optional Discord bot in one container. It connects to Emby and Jellyfin through their APIs, so it needs only its own data directory. Do not mount your media libraries or either media server's configuration directory.

## Choose an example

- [Standalone Portainer stack](../examples/compose.portainer.yaml): use reachable hostnames or server addresses in the setup wizard and Settings.
- [Stack on an existing Docker network](../examples/compose.shared-network.yaml): connect Jellyport to the network used by your media servers or reverse proxy.
- [Repository Compose file](../compose.yaml): build from source and retain the original `jellyport-data` named volume. This uses the image's default UID/GID `10001:10001` and publishes the web port on the host's loopback address.

The Portainer examples use a published image, list-style environment variables, and a dedicated host bind mount. Replace their generic paths and settings before deploying. These examples target Docker Standalone; run one Jellyport container against each data directory.

## Prepare the data directory

On the Linux Docker host, create a dedicated directory owned by the user and group that will run Jellyport:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /path/to/jellyport
```

Use the actual host path in the Compose volume entry. On a NAS shell already running as root, omit `sudo`. The `user: "1000:1000"` entry sets the container process's UID and GID directly; change it and the directory ownership together if your host uses different IDs. Jellyport does not interpret `PUID` or `PGID` environment variables. Docker documents the [Compose user setting](https://docs.docker.com/reference/compose-file/services/#user) and [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

Jellyport uses your Jellyfin administrator account for setup and sign-in. Use `TZ=Etc/UTC` or another valid timezone in the container environment; no localtime mount is required.

## Configure image access in Portainer

The examples use the public image `ghcr.io/cruv/jellyport:latest`. Portainer can pull it without GitHub credentials or a registry login. It supports Linux x86-64 and ARM64. Each publication follows successful CI and smoke tests on both architectures.

For a privately published fork, add a **Custom registry** in Portainer with URL `ghcr.io` and authentication enabled. Use your GitHub username and a personal access token **classic** with `read:packages` from an account that can access that package. Store the token in the registry configuration, rather than Compose. Fine-grained tokens do not support registry authentication. See [Portainer's Custom registry instructions](https://docs.portainer.io/admin/registries/add/custom) and [GitHub's Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

Create a stack using the selected example and deploy it. For later image updates, use Portainer's stack update option to pull the image again and recreate the container, retaining the same data mount.

## Complete first-run setup

Open Jellyport using its private LAN IP, local hostname, or localhost, and enter the Jellyfin server URL and an enabled Jellyfin administrator's username and nonempty password in the setup wizard. Set the public Jellyfin URL that your users should receive; selecting an existing enabled, non-administrator legacy template user is optional. The wizard can finish without one. After completing setup, add the Emby source URL and API key in Settings. Pairing requires both a private/loopback connection source and a local Host header. Complete setup before exposing a reverse proxy; the first qualifying visitor can link the server. A permitted public proxy hostname cannot perform first pairing, even when the proxy connects from a private address. For loopback-only deployments, use a local browser or SSH tunnel.

Jellyport verifies the administrator with Jellyfin, creates its own API key for background operations, and encrypts the pairing and key in `/data`. It does not retain your Jellyfin password. Subsequent sign-ins use an enabled administrator account on the linked Jellyfin server. Jellyfin must be reachable for sign-in and authorization checks.

When upgrading from shared-password sign-in, complete the wizard with your Jellyfin administrator account. The wizard keeps an existing saved Jellyfin server address fixed. Remove the obsolete `JELLYPORT_ADMIN_PASSWORD` variable from the service configuration and Portainer's stack variables; it is ignored. Preserve the existing data directory when upgrading. Installations already paired with Jellyfin continue using their normal Jellyfin sign-in.

## Choose account defaults

Before creating or migrating accounts, configure a default account role or an optional legacy template in Jellyport Settings. These are application settings; no additional Compose environment variables are required.

Use **Account roles** to copy supported permissions, account preferences, and Jellyfin Web home/display settings from an enabled, non-administrator Jellyfin account into a new or existing saved role. Save the snapshot, then select it as the default in Settings. A saved role is encrypted and scoped to the paired Jellyfin server; the original source account is no longer required. Roles and assignments are retained in the existing `/data` directory on upgrade, so keep the database and matching `secret.key` together.

The default role affects future accounts and takes precedence over a selected legacy template and portable Emby preferences. It does not automatically reconfigure existing accounts. Use the separate assign/review/apply workflow to update chosen groups for up to 100 existing users. Client-local TV/mobile preferences cannot be configured universally. See [account roles and defaults](../README.md#account-roles-and-defaults) for details.

## Web access and server URLs

The examples publish `8000:8000`; the left number is the host port and can be changed to an unused port. Open `http://YOUR_SERVER_ADDRESS:8000` for the HTTP configuration. It publishes on the host's interfaces, so choose the binding appropriate to your network. The repository Compose file uses `127.0.0.1:8000:8000` for local access or a host reverse proxy.

After pairing, route your HTTPS reverse proxy to Jellyport's container port `8000`, set `JELLYPORT_SECURE_COOKIE=true`, and add its hostname to `JELLYPORT_ALLOWED_HOSTS`, then recreate the container. For example, set `JELLYPORT_ALLOWED_HOSTS=jellyport.example.com` in Portainer's stack environment variables. Use comma-separated hostnames without schemes, ports, paths, or wildcards. IP literals, single-label names, `.local`, `.localhost`, and `.home.arpa` names are permitted by default; other DNS names require this setting.

Preserve the original Host header, including a nondefault browser port. Jellyport compares browser Origin headers against it and rejects cross-site API requests. Do not expose first-run setup through a proxy that rewrites a public hostname into a local one. Forwarded IP headers are not trusted; proxy clients share its peer address for rate limits. Keep the raw application port private. Keep `JELLYPORT_SECURE_COOKIE=false` while accessing the app over HTTP, because browsers will not send a secure session cookie over HTTP. HTTP alone does not encrypt administrator passwords or session cookies; use HTTPS or an encrypted VPN for confidential access. Serve the app at the root of its host or subdomain. A proxy container must be able to reach Jellyport, typically through a shared Docker network. See [the security review](security-review.md) for the data and trust model.

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

If the setup page reports an unreachable server, confirm that the Jellyfin URL is reachable from the container and includes the correct port and any reverse-proxy base path. Jellyfin sign-in requires an enabled administrator account. The Jellyfin service key is managed separately; if it is revoked, sign in as a Jellyfin administrator and refresh the key from Settings. Refresh creates a new key and keeps the previous one available for already queued jobs; remove obsolete Jellyport keys in Jellyfin's dashboard after those jobs finish.

For a permission-denied startup message, check that the mounted directory and its existing database, journal files, and `secret.key` are owned by the configured container user and group. The bind-mount examples use `1000:1000`; the default named-volume deployment uses `10001:10001`.

Bind-mount source paths refer to the Docker host. A directory reached through a mounted NAS share on a laptop can have a different path and displayed owner from that same directory on the server. Check the server-side path and permissions. If moving Jellyport into another stack, verify that its volume entry still points to the intended data directory.

## Reset Jellyfin pairing

For local recovery, stop Jellyport and run the reset command against the same data mount and image. Recovery retains the linked Jellyfin server's address and verifies its identity. To link a different Jellyfin server, start a fresh Jellyport installation with a new data directory; existing account links and jobs belong to the original server.

With the repository Compose file:

```sh
docker compose stop jellyport
docker compose run --rm --no-deps jellyport node dist/server/reset-auth.js
docker compose up -d jellyport
```

The command confirms that authentication was reset. Open Jellyport and complete the wizard again using your Jellyfin administrator account.

If the same Jellyfin server has moved to a new address, add `--server-url http://NEW_JELLYFIN_ADDRESS:8096` after `reset-auth.js` in the reset command. This changes the address used by the wizard while still requiring the original Jellyfin server's identity. Without this option, recovery keeps the previous address fixed.

For a Portainer bind-mount deployment, stop the container in Portainer, then run the equivalent command on the Docker host with its actual data directory and configured UID/GID:

```sh
docker run --rm --user 1000:1000 \
  -e JELLYPORT_DATA_DIR=/data \
  -v /path/to/jellyport:/data \
  ghcr.io/cruv/jellyport:latest node dist/server/reset-auth.js
```

Use the same image version as the stopped container, then start Jellyport in Portainer and complete setup with your Jellyfin administrator account. Reset preserves server settings, account links, jobs, history, and `secret.key`; it requires setup again against the same Jellyfin server. Keep the app stopped throughout the reset, and never delete the database or encryption key to recover a login.

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
