# Docker and Portainer deployment

Jellyport runs its web interface, API, and optional Discord bot in one container. It connects to Emby and Jellyfin through their APIs, so it needs only its own data directory. Do not mount your media libraries or either media server's configuration directory.

## Choose an example

- [Standalone Portainer stack](../examples/compose.portainer.yaml): use reachable hostnames or server addresses in Jellyport Settings.
- [Stack on an existing Docker network](../examples/compose.shared-network.yaml): connect Jellyport to the network used by your media servers or reverse proxy.
- [Repository Compose file](../compose.yaml): build from source and retain the original `jellyport-data` named volume. This uses the image's default UID/GID `10001:10001` and publishes the web port on the host's loopback address.

The Portainer examples use a published image, list-style environment variables, and a dedicated host bind mount. Replace their generic paths and settings before deploying. These examples target Docker Standalone; run one Jellyport container against each data directory.

## Prepare the data directory and password

On the Linux Docker host, create a dedicated directory owned by the user and group that will run Jellyport:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /path/to/jellyport
```

Use the actual host path in the Compose volume entry. On a NAS shell already running as root, omit `sudo`. The `user: "1000:1000"` entry sets the container process's UID and GID directly; change it and the directory ownership together if your host uses different IDs. Jellyport does not interpret `PUID` or `PGID` environment variables. Docker documents the [Compose user setting](https://docs.docker.com/reference/compose-file/services/#user) and [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

Generate the administrator password:

```sh
openssl rand -base64 32
```

In Portainer's stack editor, add an environment variable named `JELLYPORT_ADMIN_PASSWORD` with the generated value. For command-line Compose, save the value in an uncommitted `.env` file beside your Compose file:

```dotenv
JELLYPORT_ADMIN_PASSWORD=YOUR_GENERATED_PASSWORD
```

Keep this password outside the repository. The app rejects an empty password, passwords shorter than 12 characters, and its example placeholder. Use `TZ=Etc/UTC` or another valid timezone in the container environment; no localtime mount is required.

## Configure image access in Portainer

The examples use the public image `ghcr.io/cruv/jellyport:latest`. Portainer can pull it without GitHub credentials or a registry login. It supports Linux x86-64 and ARM64. Each publication follows successful CI and smoke tests on both architectures.

For a privately published fork, add a **Custom registry** in Portainer with URL `ghcr.io` and authentication enabled. Use your GitHub username and a personal access token **classic** with `read:packages` from an account that can access that package. Store the token in the registry configuration, rather than Compose. Fine-grained tokens do not support registry authentication. See [Portainer's Custom registry instructions](https://docs.portainer.io/admin/registries/add/custom) and [GitHub's Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

Create a stack using the selected example and deploy it. For later image updates, use Portainer's stack update option to pull the image again and recreate the container, retaining the same data mount.

## Web access and server URLs

The examples publish `8000:8000`; the left number is the host port and can be changed to an unused port. Open `http://YOUR_SERVER_ADDRESS:8000` for the HTTP configuration. It publishes on the host's interfaces, so choose the binding appropriate to your network. The repository Compose file uses `127.0.0.1:8000:8000` for local access or a host reverse proxy.

For HTTPS, route your reverse proxy to Jellyport's container port `8000`, set `JELLYPORT_SECURE_COOKIE=true`, and recreate the container. Keep it `false` while accessing the app over HTTP, because browsers will not send a secure session cookie over HTTP. Serve the app at the root of its host or subdomain. A proxy container must be able to reach Jellyport, typically through a shared Docker network.

Enter media server URLs and API keys in Jellyport Settings after signing in. With the standalone example, use hostnames or server addresses reachable from inside the Jellyport container, including each server's published port. `localhost` points to Jellyport's own container.

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

## Existing installations and backups

The repository Compose file continues to mount the `jellyport-data` named volume and use UID/GID `10001:10001`. Preserve its Compose project name, volume, and administrator password when updating it from source:

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

For bind-mount deployments, stop Jellyport in Portainer and copy the complete host data directory to a new backup location. Restore the database and `secret.key` from the same backup while the service is stopped; retain any SQLite journal files present in the stopped backup. The key is required to decrypt saved server credentials. Protect the backup as you would the live data directory, and keep the administrator password separately. Start only one container against the restored data.
