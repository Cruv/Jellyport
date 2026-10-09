# Jellyport

Jellyport is a self-hosted web app for moving one or several users from Emby to Jellyfin, creating accounts with saved permission and preference roles, and optionally delivering new credentials through Discord. One Discord owner can have up to three Jellyfin accounts through a paid subscription or complimentary access. Independent accounts do not require Discord or a subscription. It also provides an administrator review queue for MEE6 membership announcements and Discord membership role changes, with optional automatic provisioning and access removal.

The app uses TypeScript throughout: React/Vite for the web interface, Fastify on Node.js for the API, discord.js for the optional bot, and SQLite for encrypted settings, account links, audit records, and queued jobs. Docker packages the built interface and API together.

This is an initial implementation. Automated tests and the local demo cover the implemented workflows; compatibility has not yet been validated against your live Emby, Jellyfin, or Discord servers.

![Jellyport demo dashboard](docs/jellyport-preview.jpg)

## Run with Docker Compose

### Portainer or a prebuilt image

The public image is `ghcr.io/cruv/jellyport:latest`, published for Linux x86-64 and ARM64 after the main branch passes CI. Portainer can pull it without GitHub credentials. Each publication also has a `sha-<full-commit-sha>` tag for selecting a commit; pin the image's manifest digest when you need an immutable deployment.

Paste [examples/compose.portainer.yaml](examples/compose.portainer.yaml) into Portainer's stack editor, or use this equivalent example:

```yaml
---
services:
  jellyport:
    image: ghcr.io/cruv/jellyport:latest
    container_name: jellyport
    user: "1000:1000" # Host UID:GID.
    environment:
      - JELLYPORT_DATA_DIR=/data
      - JELLYPORT_SECURE_COOKIE=false # Set true for browser HTTPS; local setup still works.
      - JELLYPORT_ALLOWED_HOSTS=${JELLYPORT_ALLOWED_HOSTS:-} # Optional proxy/custom DNS hostnames.
      - TZ=Etc/UTC # Optional.
    volumes:
      - "/path/to/jellyport:/data"
    ports:
      - "8000:8000"
    restart: unless-stopped
    stop_grace_period: 35s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    pids_limit: 128
```

Replace the host path and prepare that dedicated directory on your Docker host before deployment:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /path/to/jellyport
```

`user: "1000:1000"` sets the real process UID and GID; change it and the directory owner together if your host uses different IDs. Jellyport does not use `PUID` or `PGID` environment variables.

Create a dedicated API key in Jellyfin's **Dashboard → Advanced → API Keys** first, then open `http://YOUR_LAN_IP:8000` or `http://localhost:8000` and complete the setup wizard with your Jellyfin server URL and that key. Set the public Jellyfin URL; selecting a legacy template user is optional. Initial pairing requires both a private connection source and a local hostname or private IP address; complete it before exposing any reverse proxy. The first qualifying visitor can pair the installation.

For browser access through HTTPS, set `JELLYPORT_SECURE_COOKIE=true` and add the reverse-proxy hostname to `JELLYPORT_ALLOWED_HOSTS`, for example `jellyport.example.com` (comma-separated hostnames, without schemes or ports). You can set these before first deployment: the local wizard uses a separate setup-only cookie that works over HTTP and is cleared when pairing finishes. Then open the HTTPS address and sign in with an enabled Jellyfin administrator account. The administrator session still requires HTTPS when secure cookies are enabled. For an HTTP-only installation, leave the setting `false`. Choose a saved default account role or a template before creating or migrating accounts.

Preserve the browser's Host header. IP literals, single-label local names, and `.local`, `.localhost`, or `.home.arpa` names work by default. A public hostname cannot perform initial pairing. Use [examples/compose.shared-network.yaml](examples/compose.shared-network.yaml) when joining an existing media-server network from a separate stack; set `JELLYPORT_MEDIA_NETWORK` to the actual Docker network name. Jellyport connects through server APIs and only needs its own `/data` mount. It does not need access to media files or the Jellyfin configuration directory.

Use HTTPS or an encrypted VPN to protect API keys, administrator passwords, and session cookies in transit. Review [the security assessment and deployment assumptions](docs/security-review.md) before exposing the administration interface.

For network details, updates, backups, and moving an existing named-volume deployment, see [Docker and Portainer deployment](docs/docker-deployment.md).

### Build from source

From a checkout of this repository:

```sh
cp .env.example .env
docker compose up -d --build
```

For an HTTPS deployment, set `JELLYPORT_SECURE_COOKIE=true` and `JELLYPORT_ALLOWED_HOSTS` in `.env` before starting the container. Open [http://127.0.0.1:8000](http://127.0.0.1:8000) and complete setup with your Jellyfin server URL and a pre-created API key, then open the HTTPS reverse-proxy address to sign in with your Jellyfin administrator account. The local wizard works with secure cookies already enabled; changing the variable or restarting solely for setup is unnecessary. Compose binds to `127.0.0.1:8000` by default; an SSH tunnel can provide localhost access from another machine during setup. A proxy in another container needs a route to the host or an explicitly configured shared Docker network. For HTTP-only access, leave `JELLYPORT_SECURE_COOKIE=false`.

The container must be able to reach both media servers. A server URL containing `localhost` refers to the Jellyport container itself. Use reachable hostnames or addresses; reverse proxy base paths are supported.

Serve Jellyport at the root of its own host/subdomain. Run one application worker/replica: mutation coordination, the Discord Gateway connection, and admin sessions are local to that process. Account mutations are serialized, with the lock released between users in a bulk job so other account operations can run.

## Set up Jellyfin sign-in and your servers

The first-run wizard links Jellyport to one Jellyfin server using an API key you create beforehand:

1. Sign in to Jellyfin as an administrator and open **Dashboard → Advanced → API Keys**.
2. Create a dedicated key. `Jellyport` is a useful label, but any name is accepted. Copy the key.
3. Enter the Jellyfin server URL and paste the key into Jellyport's setup wizard. Select an optional legacy template and set the public Jellyfin URL, then finish setup.
4. Sign in to Jellyport with an enabled Jellyfin administrator's username and nonempty password. Completing setup does not sign you in to the administration console.

Jellyport validates the key and server identity before pairing. The pending key stays in server memory until setup finishes; the saved key is encrypted in the data directory. Keys are never returned in browser responses or stored in browser storage. Jellyport does not create, delete, or revoke API keys. No setup password or API-key environment variable is required. The Jellyfin dashboard's [Advanced navigation](https://github.com/jellyfin/jellyfin-web/blob/master/src/apps/dashboard/components/drawer/sections/AdvancedDrawerSection.tsx) contains the API Keys page.

The wizard can finish without a template user. After setup, use **Account roles** to capture an enabled, non-administrator Jellyfin account's supported settings, then choose that saved role as the default in Settings. Alternatively, select a legacy template user in Settings to copy its policy and configuration during provisioning. A default account role takes precedence when both are configured. Set the public Jellyfin URL that users should receive in their credential message, and configure the Emby source URL and API key in Settings.

After setup, sign in with the linked server's Jellyfin administrator username and password. Only enabled administrator accounts are accepted. Jellyport keeps each interactive Jellyfin token in server memory, checks the account's authorization on protected requests, and revokes that token on sign-out. The background API key is separate, so signing out does not interrupt queued work or the optional bot. Jellyfin sign-in requires the linked server to be reachable.

Settings keeps the sign-in server address fixed. To replace the background key, create another key in Jellyfin first, then paste it into the API-key replacement field in Settings while signed in as an administrator. A connection or key change invalidates queued work that captured the previous settings; review and start a new job afterward. Running work stops at its next connection guard, while already accepted remote operations can still finish. Manually revoke obsolete keys in Jellyfin's dashboard. Use the [local authentication reset](docs/docker-deployment.md#reset-jellyfin-pairing) to recover access or update the linked server's address. Linking a different Jellyfin server requires a new Jellyport data directory, because existing account links and jobs belong to the original server.

Save your Emby settings and test the connections. The Emby key needs access to its users and their library data; Emby is used as a read-only source. Discord and all automatic actions are disabled by default; the web app can operate without a bot.

If the same media files have different mount paths on the two servers, configure source-to-target path prefix mappings. For example, the settings API accepts:

```json
{"path_mappings": [{"source": "/mnt/media", "target": "/media"}]}
```

API keys and the Discord bot token are encrypted in the application database. Leaving a saved editable secret's input blank preserves its current value.

## Account roles and defaults

Jellyport account roles are reusable settings presets, separate from Discord membership roles and administrator authorization. They can include three groups:

| Group | Supported examples |
| --- | --- |
| Permissions | Library access, remote access, downloads, parental controls, and playback/transcoding permissions. Administrator access, disabled state, login providers, passwords, and authentication counters are excluded. |
| Account preferences | Audio/subtitle languages, subtitle mode, autoplay, remembered track selections, library ordering/exclusions, and hiding played items from Latest Media. |
| Home and display preferences | Shared server-backed Home sections and their order, TV layout orientation, library landing pages, episode-image choices, skip intervals, and supported display/sorting preferences. |

To create or revise a role:

1. Open **Account roles**, choose **Create a new role** or an existing saved role, and give it a name.
2. Choose **Copy settings from** an enabled, non-administrator Jellyfin account. A legacy template account is also an eligible source. Click **Copy settings** and review the captured fields and import notes.
3. Save the new role or replace the existing role. The saved snapshot is encrypted and scoped to the linked Jellyfin server. It is independent of the source account; later source-account changes do not alter the role, and the source account is no longer required after saving.
4. To use it for future accounts, select it as the **Default account role** in Settings. New accounts receive its permissions and preferences, including supported home settings. The role's preferences take precedence over portable Emby preferences during a new-account migration.
5. To update existing accounts, select up to 100 eligible users and click **Assign role**. Each account has one assigned Jellyport role. Assignment alone does not change Jellyfin. Select the setting groups, click **Review changes**, and then **Apply settings** to queue the update.

Reimporting settings or saving an edited role never automatically updates existing accounts. You can apply only preferences while preserving permissions, or choose another combination. Applying settings preserves passwords, watch history, favorites, and playlists. Administrators, disabled accounts, and the selected legacy template are excluded from update targets. Existing-account migrations preserve their current settings; use the separate role update workflow when you intend to change them.

Application status records the role revision successfully applied to each setting group. **Up to date** means all captured groups were applied successfully; it is not a live comparison with Jellyfin and does not detect later user changes or enforce settings continuously. Refresh roles after a job finishes to see the recorded status. Review Activity for failed or partial updates.

Home preferences are copied into Jellyfin's shared server-backed account settings, so compatible TV/mobile apps can use them too. The snapshot includes all supported returned Home rows, their order, hidden rows, default selections, and horizontal/vertical TV layout. Jellyfin Web and compatible clients decide how to render the shared values. Roles capture a bounded allowlist rather than arbitrary client data; genuinely device-local options such as themes, subtitle styling, and some Next Up controls remain local. Unsupported or unavailable fields are reported during import. Users can subsequently change preferences allowed by their Jellyfin permissions.

For a complete Home update on existing accounts, also select **Account preferences** to copy library order, Home library visibility, Latest Media exclusions, and hiding played items. **Home and display preferences** controls Home rows, TV orientation, and the supported display options.

For roles saved before 0.6.1, copy settings from the source account again and replace the role to capture TV layout and explicit default Home-row selections. Apply **Home and display preferences** to existing assigned accounts, or use the refreshed role for future accounts. Replacing the saved role alone does not push changes.

## Migrate users

Select 1–100 distinct Emby users, review the preview, and start the migration. Usernames match exactly by default. Use **User mappings** for simplified usernames, different existing Jellyfin usernames, or other identity exceptions; case-only conflicts are never guessed.

Choose **Complete** (the default) to copy every supported personal-data type described below. **Watched only** is an optional faster pass: it marks matched Emby-watched items as played in Jellyfin. With the modern user-data API, it includes the valid original playback date when marking an item played if the destination has no date or an older one, helping Jellyfin rebuild Next Up without replacing newer dates. It skips resume positions, play counts, favorites, ratings/likes, playlists, profile images, and source playback preferences. New accounts still receive normal role/template defaults and generated passwords. The selected scope applies to both the preview and the queued migration; changing it requires a new review.

Live preview checks identities, mappings and protected destinations without scanning either library or reading playlists. It clearly defers history counts and matching details until the approved migration, whose results report unmatched and ambiguous media. A saved-snapshot preview can show those details before approval. Reviews run asynchronously, remain private to the administrator session, and clear on sign-out, restart or a configuration change. They have a 15-minute deadline and 10-minute completed-result retention. Cancel an unwanted review or migration through the interface. Already-applied changes remain after cancellation. For a failed review, see [migration troubleshooting](docs/migration-capabilities.md#troubleshooting-a-migration-review).

Saved-snapshot previews and saved job details are bounded to the first 200 unmatched and 200 ambiguous items per user, with up to 20 candidates for each ambiguous match. Summary counts cover the eligible matching work; these diagnostic limits do not truncate the actual migration. Live preview displays deferred statistics rather than presenting unknown counts as zero.

Migration combines watched flags and favorites, preserves the larger play count and later playback date, and transfers resume positions when the source is demonstrably newer or Jellyfin has no competing progress. Existing Jellyfin progress wins when chronology is unknown or tied. Personal ratings and likes fill empty fields. Movies, episodes, music, books, photos, and identifiable containers are supported; aggregate season/series completion is derived from episode history instead of copied.

Matching uses provider IDs, series identity with season/episode numbers, and exact file paths with optional prefix mappings. It does not guess from titles. Conflicting metadata and duplicate editions are reported as ambiguous; missing matches are reported as unmatched. Those items are skipped and the job is marked partial so you can review them, correct metadata or mappings, and rerun the merge.

User-visible Emby playlists become **private copies owned by the destination user**, with matched entries in order. Existing Jellyfin playlists are preserved. Jellyfin 12 preserves repeated entries; 10.9–10.11 removes duplicates and the migration reports this. Creation sets privacy and all entries in one request. An encrypted import journal prevents blind replay after an uncertain response; later migrations never append to copies that their owners might have made public or shared.

New destination accounts receive a generated 24-character password and the configured default role's permissions and preferences. Without a default role, the legacy template supplies policy/configuration and portable Emby playback preferences can transfer over its configuration. A bounded profile image can also transfer to new accounts. Existing accounts keep their passwords, permissions, preferences, and profile images. Administrators, disabled accounts, and any selected legacy template user are protected from migration.

During migration, Jobs shows the current account and phase, matched items checked, and items updated. Source migrations and saved-snapshot detail reviews serialize their expensive work. Account mutations also remain serialized; up to four independent destination items within the current account can transfer concurrently. Items already merged in the destination view need no additional history request. Potential detailed updates still refresh that account's destination data immediately before merging, and multiple source entries targeting the same Jellyfin item remain ordered. Live target history and permissions are not cached across accounts.

Approved live migrations reuse one user-neutral Emby matching catalog across accounts, with personal state excluded. The cache binds the server URL, API key, identity and version, and normally expires after ten minutes. A job pins its catalog instead of rebuilding it halfway through a bulk move. Each account's complete state is read live in explicit batches of at most 100 catalog IDs, without recursive enumeration, name sorting or total counts. This includes supported state that played/favorite/resumable filters miss. Library additions or metadata changes after collection can require another migration.

One shared source governor admits one migration read at a time and leaves at least 500 ms idle after completion. A two-second response, five-second deadline, network/server rejection, or cancellation of an active request opens a five-minute cooldown, extended by a longer bounded server Retry-After hint. Heavy source reads are not automatically retried. Catalogs, account state and playlist data have incremental item/payload limits; exceeding them fails rather than falling back to the old full per-user crawl. These defaults favor playback protection over bulk speed. A cold shared catalog still performs disk/database work and documented name-sorted pagination; neither live reads nor saved database capture guarantees zero impact. See [the incident analysis, defaults, validation and approval plan](docs/performance-safety.md).

Jellyfin **10.9+** is required for detailed user data and explicit private playlists. Older versions receive a limited watched/favorite merge with warnings. When the detailed user-data API is unsupported, the legacy watched-item endpoint may also change play counts, resume positions, or playback dates. Watched-only mode sends no explicit count or resume updates, but strict preservation of unrelated fields requires the modern partial-field API. Next Up and Continue Watching are rebuilt by Jellyfin from the migrated episode history, original dates, and resume positions; client cutoffs and unavailable media can affect their appearance. See [migration capabilities and limitations](docs/migration-capabilities.md) for everything supported, excluded, and reported.

### Saved Emby source snapshots

Version 0.12.0 adds an optional local snapshot helper for installations where repeated Emby catalog reads are expensive. It uses SQLite Online Backup to capture `library.db` privately while Emby runs, then creates a new database containing only allowlisted migration item metadata and personal history. Only that encrypted projection reaches Jellyport; the raw library database remains in the helper's private work directory and is removed after capture. This migration snapshot cannot restore an Emby server. A quiet period, Emby Premiere, and the native Emby backup plugin are unnecessary. Copying still consumes disk bandwidth and CPU; it can temporarily delay WAL checkpoints. A five-minute capture deadline limits the read-transaction window, and a failed capture preserves the last good snapshot.

The helper runs on the same Linux Docker host as Emby, has no network, and mounts the local database directory read-only. It has its own private `/work` mount for raw temporary copies; the web container receives only the separate snapshot exchange directory. The initial version-specific adapter targets Emby **4.10.1.0**; unknown schemas are rejected. The helper checks the mounted server's `device.txt` identity and `lastversion.txt` before and after capture against the configured API server. Authentication databases are not copied, and unrelated library tables and fields are excluded from the projection. See the [optional helper Compose example](examples/compose.snapshots.yaml) and [deployment instructions](docs/docker-deployment.md#optional-local-emby-snapshots--0120); never point it at SMB/NFS or a laptop-mounted share.

Snapshots and automatic capture are opt-in. Capture one from Settings or configure its daily schedule and timezone, then select snapshots for a migration review. The preview shows capture times and pins the exact generations for approval. A missing, expired after 48 hours, incompatible, or changed snapshot requires a new capture and review. Snapshot selection never silently switches back to a live catalog scan. The ordinary migration default remains live reads.

Both migration scopes can use saved library history. **Complete** still reads source account configuration, profile images, and playlist metadata/contents through the Emby API; **Watched only** needs live source identity validation but gets watched items from the saved library. Destination permissions and Jellyfin activity are always read live. This is a consistent library snapshot, not one simultaneous capture of every Emby database and API response. Snapshot history may be older than activity since capture. Protect the exchange directory, which contains encrypted personal data and its encryption material. See [snapshot capabilities](docs/migration-capabilities.md#saved-emby-source-snapshots--0120).

### Map accounts with different usernames

1. Open **User mappings** and choose the source Emby account.
2. Select an existing enabled Jellyfin account, or enter the simplified username for a new account. Selecting an existing account preserves its username and password.
3. With the bot connected, search for the Discord member by username or server nickname and select the result. Jellyport fills in their actual username and Discord ID automatically. Check the actual `@username` when several members have similar names. Advanced details retain a manual username label or ID fallback.
4. Save, then review the migration preview. It shows the source and destination names and any verified Discord recipient.

Mappings are encrypted and scoped to the configured servers. Each source and destination account has one mapping; a verified Discord owner can have a separate mapping for each account slot, from 1 to 3. Choose the slot when mapping secondary accounts, including simplified names. Queued work pins its mapping revision and refuses changed mappings. A created destination is pinned by Jellyfin ID so a replacement account cannot silently receive another user's data. Discord names alone are labels; verified IDs and durable account links drive automation. Saving a mapping does not itself change an account or send a message. The migration preview fixes the recipient for a saved mapping; edit that mapping to choose a different member.

## Create accounts and deliver passwords

Use the account creation form for a new member, family member, or child. Leave Discord blank for an account managed through the web app; its generated password is available through the one-time reveal after creation. Under **Users**, manually flag a family account or review and link its owner. Accounts without a confirmed Discord owner are never assumed to be paid or family accounts and are not automatically disabled. For a non-paying Discord member whose entire account allowance should be administrator managed, save complimentary access under **Memberships** before creating or linking their account. With a connected Discord bot, search for and select the member; their actual Discord username and ID fill in automatically. The same member picker is available in migration previews and incomplete-account recovery. Numeric IDs remain available under Advanced details when needed. Jellyport uses the actual username (`member.user.username`), rather than a server nickname or display name.

Member search matches username and server-nickname prefixes. Results show the actual `@username`, display name, and server nickname so you can select the correct person. It does not guess ownership from a similar name or search by display name. Searches start when you interact with the picker; opening a bulk preview does not query Discord for every user. Member search does not require an extra privileged Gateway intent.

For a newly created first Discord link, a primary account's username must match the member's current Discord username exactly unless an administrator has saved a mapping with that verified Discord ID. An administrator can also select an existing Jellyfin account by its ID under **Users → Link Discord owner**, including an account with a different name. This explicit association preserves its password, policy, preferences, and personal data; it does not perform a migration or re-enable the account. Additional accounts use the owner's numbered account slots, or their approved mappings. For mapped existing Emby members, use migration or the membership provisioning workflow so their approved destination names and history are used. Jellyport does not guess ownership from similar names or rename accounts automatically.

When a recipient is selected, account provisioning stores the Discord user ID and Jellyfin account ID as a durable link. Membership actions use this link even if the member later changes their Discord username.

### Paid, complimentary, and independent access

**Memberships** has two access policies. Subscription-managed members follow your reviewed or automatic MEE6/Discord membership events. Complimentary members have an administrator-controlled allowance of 1–3 accounts. Subscription cancellations, expiry, missing subscriber roles, and leaving Discord never revoke complimentary media access. The recipient must still be a current human member of the configured Discord server for bot commands or credential delivery; leaving Discord does not disable their media accounts.

**Save access policy** records the selected policy and allowance without creating, disabling, enabling, or changing a media account. Complimentary policy applies to the Discord owner's whole allowance; the separate **Family account** flag described below applies to one selected account. **Review membership update** shows account names and access changes; confirming queues creation, migration, or restoration of entitled slots and disables eligible extras outside the reviewed allowance. Complimentary access is saved before that queue request, so the billing exemption remains even if provisioning needs attention.

Independent accounts have no Discord owner and remain administrator managed. Create them with Discord blank, or migrate their Emby data without selecting a Discord recipient. Each account keeps its own history and password. Paid membership management requires a verified Discord ID. Accounts with neither a confirmed Discord owner nor a manually saved family flag appear in the **Users** review banner and **Needs review** filter; they are never automatically disabled. Review them by assigning a family flag or linking their verified Discord owner. There is no requirement to invent a Discord identity for children or family members.

### Family flags, private owner notes, and manual access

In **Users → Family and owner notes**, select the actual Emby or Jellyfin account and manually check **Family account**. This flag belongs to that selected media account ID, not the entire Discord member or another account with the same name. It protects a flagged Jellyfin account from subscription and tier access changes, including previously pending billing changes. Saving the flag does not enable an already disabled account, and removing it does not disable the account. Flagging an Emby source does not automatically flag its Jellyfin destination after migration; review and flag the destination separately when needed.

The same form stores an optional **Owner name** of up to 120 characters and **Private owner notes** of up to 2,000 characters. These annotations are visible only to Jellyport administrators, stored encrypted in Jellyport's local database, and never sent to Discord or either media server. Profiles are scoped to the selected account ID, server URL, and paired Jellyfin server identity rather than usernames. The upgrade adds this data without resetting existing accounts or inferring family flags from old records.

Use **Users → Manage account access** to review and enable or disable a selected account. The action verifies its exact account ID, current name, and reviewed profile revision; changed details require a new review. It preserves the account's password, history, favorites, playlists, and preferences. Jellyport has no permanent-delete button; delete an account directly on its media server if needed. Family flags do not bypass Discord recipient checks: accounts without Discord use the web app's one-time credential reveal.

### Organize users and Discord roles

The **Users** directory searches media and Discord usernames and filters by server presence and access policy. Same-name accounts may appear together for display; this pairing does not establish ownership. Only explicit account links and approved user mappings can authorize Discord tagging or membership actions. For an existing Jellyfin-only account, choose **Link Discord owner**, select the actual account and Discord member, then confirm its slot. Save a complimentary policy first for a non-paying owner. For an Emby-only account or a migration with different names, use **User mappings** to approve the source, destination name, Discord owner, and slot.

Discord organization is optional and starts with manual review. Create informational `Emby` and `Jellyfin` roles in Discord once; Jellyport does not automatically create missing roles. Under **Users → Discord organization roles**, select those existing roles from the bot's server; individual role IDs do not need to be entered. Roles must have no server permissions and be below the bot's highest role. Use dedicated tag roles that are not referenced by channel permission overwrites; Jellyport checks guild-level role permissions, not channel overwrites. The bot needs Manage Roles in addition to its normal channel permissions. If it lacks this permission, **Users → Update bot permissions** opens the server-generated invite with Manage Roles requested, allowing you to update the installation before selecting roles. After organization roles are configured, the generated invite URL includes Manage Roles for inviting or updating the bot.

By default, roles reflect every server an owner has accounts on: Emby owners receive the Emby role, Jellyfin owners receive the Jellyfin role, and owners with accounts on both servers receive both. Use informational role names such as `Emby` and `Jellyfin`. Check **Reserve the Emby role for owners who have only Emby accounts** if you prefer the Emby role to identify Emby-only owners instead. Tags reflect account existence, including disabled accounts; they do not establish billing eligibility or grant media access. Other Discord roles, including subscriber roles, are preserved.

If an existing deployment has already saved the exclusive Emby-only option, uncheck **Reserve the Emby role for owners who have only Emby accounts**, select **Save organization settings**, then preview and apply the role changes to use both roles.

Save the organization settings and use **Preview role changes** before applying. A preview expires after five minutes, can be applied once, and is rejected if its configuration or reviewed account associations have changed. Optional automatic synchronization checks every five minutes. Unlinked accounts and members confirmed to have left Discord are skipped; saved media ownership and access are retained. Missing media API credentials, unavailable servers, or failed Discord checks stop synchronization instead of treating unavailable account data as an empty server and removing roles.

### One membership with several accounts

Use **Memberships** to select a Discord member and review their account allowance. The default tiers are:

| Membership | Accounts | Example new usernames |
| --- | --- | --- |
| Sloop | 1 | `Jim` |
| Brigantine | 2 | `Jim`, `Jim_2` |
| Galleon | 3 | `Jim`, `Jim_2`, `Jim_3` |

Each slot is a separate Jellyfin account with its own password and personal data, owned by the same verified Discord ID. New credentials are sent privately to that Discord member. New accounts receive the configured default account role or legacy template. Existing linked accounts keep their passwords, history, favorites, playlists, and preferences.

An upgrade fills the missing entitled slots, migrating exact matching Emby accounts or approved slot mappings before creating fresh accounts. Existing unrelated Jellyfin usernames are not claimed automatically. A downgrade disables eligible slots outside the new allowance and keeps their data. Upgrading later restores those same accounts if Jellyport disabled them. For subscription-managed members, applying a cancellation or expiry event disables eligible linked slots; no account is deleted. Manually flagged Family accounts and complimentary members are exempt from these billing actions. Accounts disabled independently by an administrator require review instead of automatic re-enabling.

Tier names, exact trusted MEE6 plan names, and account limits are configurable in Settings. Each tier supports 1–3 accounts. Subscription plan names are matched exactly apart from capitalization and surrounding whitespace; unknown plans remain for review. A role-only event has no billing tier, so it preserves a saved tier or uses an initial one-account tier for a new member. If no one-account tier is configured, select a tier explicitly. Membership tiers control account counts; Jellyport account roles remain independent permission and preference presets.

Existing installations retain their data and primary account links when updating. Saved links and mappings become slot 1; an update alone does not create extra accounts. Review a member's tier under **Memberships** to add or change their allowance.

New passwords are encrypted and retained for up to 24 hours. After the job finishes, the web app offers a one-time reveal; revealing consumes the stored credential record. Successful Discord delivery removes that record immediately. If delivery fails, credentials remain available for the one-time reveal until expiration. Existing accounts have no new password to reveal or send.

Credential DMs contain the server URL, username, and plaintext password for the selected recipient. Command replies show only private job status. Users can change their password in Jellyfin after signing in.

If a creation times out or stops before initialization finishes, inspect Jellyfin and the recorded job before retrying. The recovery workflow first inspects an exact target account; recovery can reset its password and apply the configured provisioning defaults only when Jellyport tracks it as an incomplete creation. It preserves watched history and refuses protected or unrelated accounts.

For an incomplete numbered account, inspect its exact username and select the same Discord owner for recovery. Jellyport checks the account slot against the member's active allowance before resetting a password or linking the account. Recovery cannot claim another member's account or reactivate a slot outside the current tier.

## Optional Discord and membership automation

Follow [Discord setup](docs/discord-setup.md) to configure the bot, command permissions, trusted MEE6 announcement source, and optional membership role events.

```text
/jellyport create user:@jlogan35
/jellyport create user:@jlogan35 tier:brigantine
/jellyport migrate user:@jlogan35 emby_username:jlogan35
/jellyport status job_id:YOUR_JOB_ID
```

Recognized events appear in the subscription review queue. Apply or ignore them as an administrator. An unresolved username remains for review and cannot automatically change an account; use a verified manual account action instead.

Automatic provisioning and automatic disabling are separate switches, both off by default. Provisioning fills every account slot included in the resolved tier, using exact matching Emby accounts or approved slot mappings when available and creating fresh accounts otherwise. Automatic tier downgrades require both switches; with only automatic provisioning enabled, downgrades remain for review. Manually approving a tier update applies its access changes regardless of those switches. An existing Jellyfin account without a Discord link requires an explicit **Users → Link Discord owner** association or an admin-approved migration before subscription automation can manage it. A member with multiple saved Emby mappings must specify `emby_username` when using `/jellyport migrate`.

Cancellation announcements default to review because cancellation can happen before paid access expires. For subscription-managed members, role removal or departure is treated as expiry; linked memberships are checked on startup/reconnect and every five minutes when role events are enabled. With automatic provisioning also enabled, reconciliation scans current active-role members for unlinked subscribers, including members who joined during downtime. Enabling this combination can provision all currently eligible unlinked members. Immediate disabling on cancellation is an explicit additional option. An applied cancellation remains a hold until a fresh subscription or role-add event, or a manual membership update; routine reconciliation cannot undo it. Jellyport has no direct MEE6 billing API integration or paid-through date tracking.

Subscription lifecycle actions apply only to subscription-managed members and disable eligible accounts rather than deleting them. Manually flagged Family accounts, complimentary members, and accounts without a confirmed Discord owner are exempt. Passwords and watched history are preserved. Returning members can regain access to accounts that Jellyport disabled; accounts disabled independently by an administrator are not automatically re-enabled.

### Private administrator messages

All administrator slash-command replies are ephemeral, visible only to the person who ran the command. Optional background alerts send job outcomes and subscription events needing review to one selected administrator by DM. Run `/jellyport alerts action:enable` in your Discord server to register yourself without entering an ID. Jellyport rechecks your administrator access and tests DM delivery before enabling alerts; they are off by default. Another authorized administrator can replace the recipient only after their own test DM succeeds.

Use `/jellyport alerts action:status`, `action:test`, or `action:disable` to check delivery, send yourself a test, or stop your alerts. A test does not change the recipient or retry timing. Failed notices retry after one minute, then every five minutes; the selected administrator can run **enable** again to retest delivery and reset the delay while preserving pending notices. **Settings → Discord → Private admin alerts** shows the current recipient, pending count, last delivery, and delivery error. Web administrators can refresh that status or stop administrator DMs after reviewing the current recipient. Failed DMs never fall back to a shared channel.

Enabling starts with future changes rather than sending existing job history or review items. Job outcomes and pending or failed subscription events are included; unlinked users and organization-role synchronization errors still need review in the web app.

Alerts contain summaries rather than affected users' names, credentials, private owner notes, internal URLs, or raw error details. Open Jellyport for the full review. Credential DMs remain separate and go only to the selected account owner. Background notifications use DMs because [Discord interaction tokens expire after 15 minutes](https://docs.discord.com/developers/interactions/receiving-and-responding#followup-messages); DMs are private from other server members, but Discord handles them and [text messages are not end-to-end encrypted](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted). See [Discord setup](docs/discord-setup.md#private-administrator-alerts) for the commands and delivery requirements.

### Planned automation improvements

The most useful next steps for reducing administrator input are:

1. **Bulk mapping suggestions with approval:** suggest matching Emby, Jellyfin, and Discord accounts together, then approve clear matches in one review while retaining explicit handling for exceptions.
2. **More role and channel pickers:** extend the existing organization-role selectors to subscription/admin roles and announcement channels during setup.
3. **An exception dashboard:** bring unresolved identities, failed credential delivery, interrupted jobs, and membership-check failures into one actionable queue.
4. **Scheduled migration catch-up:** repeat the merge for selected linked users until their move is complete, preserving newer Jellyfin activity.
5. **Paid-through access and tier-specific settings:** extend account-count tiers with saved account-role selection, verified billing status, renewal dates, and grace periods.

These are future features. We have not found a documented public MEE6 billing API. Stripe integration needs verification of the connected account's API/webhook access and a reliable Discord identity link. [MEE6's Stripe guide](https://mee6bot.freshdesk.com/support/solutions/articles/101000472733-server-owner-how-to-see-information-about-subscribers-on-stripe) says Standard accounts can expose a subscriber's Discord ID in the initial Checkout Session request logs, which may only remain available for one year; Express account owners must contact MEE6. Seeing those details in the dashboard does not establish that Jellyport can retrieve them through an API.

## Data and backups

The repository's default `compose.yaml` stores application data in the `jellyport-data` named volume mounted at `/data`. The Portainer examples instead use your chosen host bind directory. Both contain `jellyport.db`, SQLite journal files when present, and `secret.key`. Server secrets, retained passwords, account roles, role assignments, and membership entitlement records are encrypted; audit records, usernames, account links, and job summaries are stored as ordinary database records. The encryption key is stored beside the database, so protect the entire volume or directory and its backups.

Stop the service before copying its data, and use a new destination directory for each backup:

```sh
docker compose stop jellyport
docker compose cp jellyport:/data ./jellyport-backup
docker compose start jellyport
```

Restore the database and `secret.key` together while the service is stopped. Without the original key, saved secrets cannot be decrypted. Keep the volume when rebuilding or upgrading. The saved Jellyfin pairing is part of this data directory.

New jobs persist their requests and an encrypted settings snapshot before execution. Jobs that have never started can resume after a restart. Running jobs are marked interrupted for review and are not silently replayed: a remote creation or policy change may already have succeeded. Rerunning a reviewed migration merges remaining data without resetting ordinary existing accounts.

Item counters and other observational progress are checkpointed periodically rather than after every item, so the last saved count can lag a sudden stop. This is progress reporting, not an automatic per-item resume cursor. The account uncertainty record is saved before sending the create request, closing the crash window before its result is recorded; playlist uncertainty journals also retain their immediate safety writes. Keep the interrupted job for review, then rerun the approved merge for the affected account; do not assume that every unsaved progress increment represents an unapplied change.

### Upgrading from the Python version

Keep the same Compose project name, `jellyport-data` volume, and `.env`. Back up the stopped service as described above, pull the updated repository, then run `docker compose up -d --build`. The Node application reads the original SQLite schema and Fernet-encrypted records using the existing `secret.key`; no Python runtime or export/import step is required. It adds the queued-job table on startup. Old queued/running jobs lack a durable execution record and are marked interrupted for review. Settings, credentials within their retention period, account links, and audit history remain available.

Do not run both versions against the same volume. Keep your pre-upgrade backup if you need to roll back, and restore it while the service is stopped.

### Upgrading from shared-password sign-in

Keep the same data mount and back it up before updating the image. On the first visit after upgrading, complete the setup wizard with a pre-created Jellyfin API key, then sign in with your Jellyfin administrator account. If a Jellyfin URL is already saved, the wizard keeps that server address fixed. Existing accounts, jobs, links, and settings remain in the data directory. Remove `JELLYPORT_ADMIN_PASSWORD` from your stack configuration if present; it is ignored. Installations already paired with Jellyfin keep their existing background key and normal Jellyfin sign-in; the change to manual key setup does not require resetting or deleting data.

## Development and local demo

Use Node.js 24 (recommended) or Node.js 22.16 or newer in the 22.x series. Node 22.16 is required for the SQLite backup API used by the optional helper. Dependencies are pinned in `package-lock.json`:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

For real local operation, run:

```sh
HOST=127.0.0.1 npm start
```

Open the app and complete the setup wizard with your Jellyfin server URL and a pre-created API key, then sign in with your Jellyfin administrator account.

The demo uses simulated in-memory servers, makes no Emby/Jellyfin/Discord API calls, and keeps settings read-only. Use a separate data directory:

```sh
JELLYPORT_DEMO=true \
JELLYPORT_DATA_DIR=/tmp/jellyport-demo \
JELLYPORT_SECURE_COOKIE=false \
HOST=127.0.0.1 npm start
```

Sign in with username `admin` and password `demo-jellyport`. Demo server fixtures reset when the process restarts. Demo startup refuses a directory containing production settings, authentication, or user data.

For development with hot reload, run `npm run dev` for the API and `npm run dev:ui` in a second terminal. Open Vite's local URL at [http://127.0.0.1:5173](http://127.0.0.1:5173); it proxies `/api` to the Node service at port 8000. Production uses the compiled `dist/server` and `dist/client` files. Source lives in `server/` and `frontend/src/`; Vitest covers backend, Discord, persistence compatibility, and React safeguards. CI checks Node 22 and 24, the production build, dependency vulnerabilities, and a Docker demo smoke test.

## API

The browser uses authenticated session cookies. Mutating API requests require the session's `X-CSRF-Token`; get an anonymous session from `GET /api/session` before calling `POST /api/login` with a Jellyfin `username` and `password`. First-run setup uses the same CSRF protection and validates a pre-created Jellyfin API key and the server identity before pairing. With secure cookies enabled on an unpaired installation, qualifying local setup requests use a separate HttpOnly, SameSite Strict cookie scoped to `/api`, without the Secure attribute. It is accepted only for setup and is cleared when pairing finishes. Setup does not establish an administrator session; a separate Jellyfin administrator sign-in is required. Ordinary session cookies retain the configured Secure setting. Jellyfin access tokens and API keys are not returned to the browser. `/health` is unauthenticated. There is no public subscription webhook endpoint.

| Operation | Endpoint |
| --- | --- |
| Read or update configuration | `GET` / `PUT /api/settings` |
| Connect Jellyfin and complete first-run setup | `GET /api/setup`, `POST /api/setup/connect`, `POST /api/setup/complete` |
| Replace the background key with a pre-created key | `POST /api/auth/service-key` with `{"api_key": "NEW_KEY"}` |
| Read, save, or remove account roles | `GET` / `POST /api/account-roles`, `DELETE /api/account-roles/:id` |
| Capture supported Jellyfin user settings | `POST /api/account-roles/import` |
| Assign or unassign saved roles without remote writes | `POST /api/account-roles/assign`, `POST /api/account-roles/unassign` |
| Queue selected role setting groups for assigned users | `POST /api/account-roles/apply` |
| Test server connections | `POST /api/connections/test` |
| List source and destination users | `GET /api/users` |
| Read the combined user directory | `GET /api/user-directory` |
| Save a selected account's family flag and private owner notes | `POST /api/account-profiles` |
| Enable or disable a reviewed media account | `POST /api/accounts/access` |
| Explicitly link an existing Jellyfin account to a Discord owner | `POST /api/accounts/link` |
| Search Discord server members | `GET /api/discord/members?query=USERNAME_OR_NICKNAME_PREFIX` |
| Read or stop private administrator alerts | `GET /api/discord/admin-alerts`, `POST /api/discord/admin-alerts/disable` |
| Start background migration history review | `POST /api/migrations/preview` (202 Accepted) |
| Poll or cancel an owned history review | `GET` / `DELETE /api/migrations/preview/{id}` |
| Queue a reviewed migration | `POST /api/migrations` |
| Create a new account | `POST /api/accounts` |
| Read managed memberships or provision a member's account allowance | `GET /api/memberships`, `POST /api/memberships/provision` |
| Save a paid or complimentary access policy without media account changes | `POST /api/memberships/access` |
| Discover safe Discord organization roles | `GET /api/discord/tag-roles` |
| Preview or apply Discord organization role changes | `POST /api/discord/tags/preview`, `POST /api/discord/tags/apply` |
| Inspect or recover an incomplete creation | `GET /api/accounts/recovery`, `POST /api/accounts/recover` |
| List or inspect jobs | `GET /api/jobs`, `GET /api/jobs/{job_id}` |
| Cancel queued or running work and preserve applied changes | `POST /api/jobs/{job_id}/cancel` |
| Consume retained credentials | `POST /api/jobs/{job_id}/credentials` |
| Review, apply, or ignore membership events | `GET /api/subscriptions`, `POST /api/subscriptions/{event_id}/apply`, `POST /api/subscriptions/{event_id}/ignore` |

Both migration POST endpoints accept optional `migration_scope: "complete" | "watched_only"`, defaulting to `"complete"`; unknown or non-string values are rejected. For example, start a watched-only review with `{"source_user_ids":["EMBY_USER_ID"],"migration_scope":"watched_only"}` and send the same scope when queuing the reviewed migration.

`POST /api/migrations/preview` returns `{id, status, progress}` immediately. Poll its ID for `status: "running"`, `"ready"`, or `"failed"`; `progress` contains completed user count `processed` and selected user count `total`. A ready response includes `preview: {users, mode, migration_scope}`, and a failed response includes a sanitized `error`. Live review users have `history_deferred: true` and `stats: null`; clients must not treat those unknown counts as zero. The browser polls once per second. Polling requires the same currently authorized administrator session; canceling also requires its CSRF token. Expired, cleared, or another session's IDs return 404. Tasks remain in memory, with at most two running and sixteen retained tasks; expensive snapshot reviews serialize with actual source migrations. Persistent jobs have a separate cancel route: queued cancellation removes the encrypted request, and active cancellation preserves applied changes and requires review before rerunning.

API contracts were checked against [Emby API-key authentication](https://dev.emby.media/doc/restapi/API-Key-Authentication.html), [Emby user items](https://dev.emby.media/reference/RestAPI/ItemsService/getUsersByUseridItems.html), and Jellyfin's [user controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/UserController.cs) and [playstate controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/PlaystateController.cs). Run a migration preview and test one account on your server versions before a bulk migration.
