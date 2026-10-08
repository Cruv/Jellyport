# Security review — 8 October 2026

This review covers Jellyport's TypeScript server, React interface, Jellyfin authentication and first-run setup, persistence, account and Discord ownership checks, Docker configuration, dependencies, and GitHub release workflows. It includes the hardening changes described below.

The work consists of ordinary code review, defensive regression tests with synthetic data, and passive dependency, image, secret, and workflow checks. Tests use application injection and controlled local fixtures. No deployed NAS, real media-server accounts, Discord guild, MEE6 membership, Stripe account, or Portainer instance was targeted. Dependency registries, image registries, and public security advisories were consulted for passive checks. This is a focused review, not an independent penetration-test certification or a guarantee that every vulnerability has been found.

## Trust and data model

- An enabled Jellyfin administrator is trusted to control the whole Jellyport installation, including viewing migration results, changing integrations, creating accounts, and requesting generated credentials. Jellyport does not provide separate operator roles or tenant isolation.
- First pairing trusts the operator on the local network. It requires both a private or loopback connection source and a local request hostname. The first qualifying visitor can select the Jellyfin server and prove administrator access to it. Complete setup before making Jellyport reachable by untrusted users. A permitted public reverse-proxy hostname cannot perform first pairing; a proxy must preserve the incoming Host header and must not expose setup through a rewritten local hostname.
- After pairing, the authentication server's URL and identity are bound separately from editable integration settings. Interactive sessions are checked against the bound Jellyfin server and its current administrator policy. Background work uses a separate privileged API key, which remains valid until revoked on Jellyfin.
- Jellyfin passwords are used to authenticate and are not persisted by Jellyport. Interactive access tokens remain on the server. The browser receives an opaque session cookie and a CSRF token, rather than a Jellyfin access token or service API key.
- Saved API keys, bot tokens, queued settings snapshots, and retained generated passwords are encrypted. The encryption key, `secret.key`, resides beside `jellyport.db`. Anyone who can read both files or their backups can decrypt those secrets. Restrict access to the host, data mount, and backups; encryption does not protect against a compromised host or a compromised Jellyport administrator session.
- The database is not fully encrypted. Account names, Discord account links, subscription events, and job metadata are readable to a database reader. Watch-history-derived results and watched-media titles in job metadata are also readable; secret-field encryption does not protect the watch history stored on the linked media servers. Deleting an expired credential does not erase earlier backups or guarantee forensic removal from SQLite storage.
- Plain HTTP exposes passwords, session cookies, and user data to parties able to observe the network path. Use HTTPS or a trusted encrypted network for browser access and protect Jellyport's connections to Jellyfin and Emby as well. Set `JELLYPORT_SECURE_COOKIE=true` when browser access uses HTTPS. A Secure cookie alone does not encrypt an HTTP connection.

## Findings addressed

| Area | Finding | Change |
| --- | --- | --- |
| First pairing and browser trust | An unconfigured installation accepted arbitrary Host/Origin values and allowed remote visitors to initiate pairing against a server of their choice. Setup could also initiate fixed-path requests to an arbitrary HTTP(S) destination. | Added Host validation, matching-Origin checks, cross-site request rejection, and the local-source plus local-hostname pairing boundary. Private Jellyfin addresses remain supported for the trusted setup operator. |
| Session availability | A caller could allocate anonymous sessions until the shared global capacity prevented administrators from obtaining sessions. | Separated bounded anonymous and authenticated pools. Anonymous allocation is limited to 30 sessions per source address and 60 allocations per ten minutes. Existing administrator sessions are not evicted by anonymous-pool pressure. |
| HTTP resource use | Slow requests and unbounded upstream responses could hold connections or consume excessive memory. | Added finite inbound HTTP timeouts and bounded upstream reads: 1 MiB for authentication responses and 8 MiB for media responses. Declared and streamed oversize bodies are rejected; timeouts remain active while bodies are read. |
| Demo data isolation | Starting demo mode against production data could expose real records behind the published demo login and replace integration settings. | Demo mode refuses a production data directory. It requires a separate demonstration directory and uses simulated integrations. |
| Browser data minimization | The user-list route forwarded complete upstream user objects, including fields the interface does not use. | User lists now return only ID, name, administrator status and disabled status. Extra configuration, session, token, or plugin fields stay on the server. |
| Logout privacy | A failed logout request left private data displayed, and a retained browser cookie could restore the console during a sign-in refresh. | Logout has a finite deadline and clears private interface state on success or failure. Failed confirmation is reported; automatic refresh cannot reopen the console before a new explicit sign-in succeeds. Server-side logout immediately forgets the session and clears its cookie before attempting Jellyfin token revocation. |
| Runtime packages | The image contained unused npm CLI dependencies with published advisories and an available Debian Perl security update. | Updated Debian security packages and removed runtime npm, npx, and Yarn after installing production dependencies. The builder retains its build tools. |
| Release integrity | Mutable action tags, inherited CI permissions, retained checkout credentials, and rebuilding an image after its smoke test widened the release trust boundary. | Pinned action SHAs and the official multiarchitecture Node base digest; restricted CI permissions and checkout credentials; disabled unnecessary publisher package-manager caching. Each architecture's candidate is built once with provenance and an SBOM, tested by its exact registry digest, and included in release tags only after both candidates pass. |
| Container confinement | The runtime did not require a writable root filesystem or an unrestricted process count. | Compose examples now use a read-only root filesystem, a 16 MiB `noexec,nosuid` temporary filesystem, and a PID limit of 128, alongside the existing unprivileged user, dropped capabilities, and `no-new-privileges`. Application data remains writable through its dedicated mount. |

The release workflow still requires a successful same-repository push to `main`, verifies the exact tested commit against current `main`, and checks again before publishing release tags. Fork pull-request code is not checked out in the privileged publisher. Untagged candidate digests can exist in the registry before smoke tests finish; `latest` and commit tags are assembled only from the candidates that passed.

## Session and user-data safeguards reviewed

The review checked authorization on canonical matched API routes, including encoded URL aliases; CSRF checks on mutations; session rotation and logout; current Jellyfin administrator validation; strict input schemas; sanitized upstream errors; and the separation of browser tokens from service credentials. Session cookies are HttpOnly and SameSite Strict. Responses use `no-store`, a restrictive Content Security Policy, framing restrictions, and a no-referrer policy.

The React interface renders untrusted names and errors as text, permits only HTTP(S) external links, and does not persist credentials in localStorage or sessionStorage. Password inputs are cleared after submission. Generated credentials have a one-time reveal operation and a retention limit; successful Discord delivery consumes the retained reveal copy. Logging and API error responses must not contain passwords or tokens.

Account and Discord regression coverage includes durable Discord-ID ownership, renamed or recycled usernames, concurrent ownership claims, membership changes while jobs wait, and manually disabled accounts. The review also checks encrypted secret records and restrictive database/key permissions. These tests use synthetic users, media, tokens, and bot adapters.

Defensive regressions cover the new Host/Origin and setup boundaries, session-pool isolation and allocation limits, bounded upstream reads and timeouts, and demo isolation. Application test totals belong to the corresponding CI result and are intentionally not fixed in this document.

## Passive check results and residual findings

Checks on 8 October 2026 included:

- `npm audit` for the complete lockfile and production dependencies: no known advisories reported. Lockfile entries have integrity hashes and resolve through the npm registry.
- Gitleaks 8.30.1 across the seven commits present at review start: two alerts, both verified synthetic fixtures—a deterministic Fernet compatibility key and a test Discord identifier. No real credential leak was identified. Additional historical pattern checks covered 359 file versions without finding private-key, access-token, or private deployment-path patterns.
- Built-frontend and exported-image checks: no emitted frontend source maps, server secrets in frontend assets, source-tree copies, or application data files in the runtime image. Runtime package-manager executables and application/dependency source maps were removed.
- All three Compose configurations validated; workflow YAML parsed and actionlint passed. Zizmor 1.28.0 findings fell from 21 to one generic `workflow_run` warning. Its untrusted-checkout concern was reviewed against the explicit same-repository, push, branch, and commit checks above.
- The hardened ARM64 image built successfully. Trivy 0.72.0 used a freshly downloaded vulnerability database for the original image and the same database for the hardened-image comparison. This passive scan did not run Jellyport against a deployed media server. It did not establish AMD64-specific runtime behavior.

| Trivy package/advisory records | Before | After |
| --- | ---: | ---: |
| Node packages bundled with the unused global npm CLI | 21 | 0 |
| Debian records with an available fixed package version | 13 | 0 |
| All Debian records, including unfixed and source-package matches | 235 | 222 |

The 13 fixed Debian records all concerned `perl-base`, upgraded from `5.36.0-7+deb12u3` to `5.36.0-7+deb12u4`. Debian documents the fixed version for [CVE-2026-13221](https://security-tracker.debian.org/tracker/CVE-2026-13221) and [CVE-2026-42496](https://security-tracker.debian.org/tracker/CVE-2026-42496). Jellyport does not invoke Perl, shell commands, or archive extractors, so the original scanner severity does not demonstrate a remote application exploit.

The remaining 222 Debian records comprise one critical, 48 high, 95 medium, 77 low, and one unknown severity match. They are package/advisory records, not 222 independently demonstrated application vulnerabilities. No fixed Debian package version was reported for them in this scan. Several involve source-package matches or utilities that Jellyport does not invoke; remaining high-severity records still require vendor-update monitoring and continued reachability review.

The remaining critical record, [CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853), concerns MiniZip code in zlib's source package. Debian explicitly says the affected MiniZip code was not built into the Bookworm binary package in question. It is therefore inapplicable to the installed `zlib1g` binary. This specific exclusion does not dismiss the other Debian findings.

Passive inspection of the final ARM64 image's ELF dependencies and installed files further classified all 48 high-severity records:

| Installed packages | High records | Relevance to the reviewed Node application |
| --- | ---: | --- |
| `bsdutils`, `libblkid1`, `libmount1`, `libsmartcols1`, `libuuid1`, `mount`, `util-linux`, `util-linux-extra` | 40 | Five mount/namespace advisories repeated across eight binaries from the same source package. They concern privileged `mount` or `nsenter` behavior, such as [target-path redirection](https://security-tracker.debian.org/tracker/CVE-2026-53613) and [cgroup-authority inheritance](https://security-tracker.debian.org/tracker/CVE-2026-78408). These libraries are not Node ELF dependencies, and Jellyport does not invoke those commands. Capability removal and `no-new-privileges` remain important. |
| `gzip` | 1 | [CVE-2026-41992](https://security-tracker.debian.org/tracker/CVE-2026-41992) affects the GNU command's LZH decoder. The command is installed but not invoked by Jellyport; Node's compression support does not execute GNU gzip. |
| `libacl1` | 1 | [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) concerns pathname ACL operations by a privileged caller. Node does not link this library, and no Jellyport ACL caller was identified. |
| `libsystemd0`, `libudev1` | 2 | [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) concerns `systemd-homed`, which is absent from this image. Neither library is a Node dependency. |
| `libtinfo6`, `ncurses-base`, `ncurses-bin` | 3 | [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) concerns the `infocmp` command, rather than Node's terminal handling. Node does not link libtinfo or invoke infocmp. |
| `perl-base` | 1 | [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) concerns `Archive::Tar`; that module is absent from the minimal installed Perl package, and Jellyport does not invoke Perl. |

That classification does not mean every remaining Debian record is unreachable. Node actually depends on `libc6`, `libstdc++6`, `libgcc-s1`, and the associated math/thread/loader libraries; the image contains no native Node addon files. Two medium-severity matches deserve explicit continued attention:

- [CVE-2026-8674](https://security-tracker.debian.org/tracker/CVE-2026-8674) affects glibc resolver initialization with an excessively long DNS search domain. Node imports `getaddrinfo`, so a malicious or invalid resolver configuration can be relevant to the running service. Keep host/Docker DNS settings and DHCP/VPN configuration under trusted control. This is a conditional availability risk, not a demonstrated HTTP data leak.
- [CVE-2026-95619](https://security-tracker.debian.org/tracker/CVE-2026-95619) concerns integer overflow in libstdc++ aligned allocation. Node imports aligned array allocation from this library. No Jellyport request path that supplies an overflowing allocation size was established; request and response bounds do not constitute a patch for the native runtime.

No fixed Bookworm package was available for these two matches during the review. They require ongoing vendor monitoring and updated image builds when fixes become available. The inspection establishes installed code and dependencies, not complete native-code reachability or proof of exploitation; the remaining medium/low records have not all received function-level analysis.

The pinned Fastify 5.12.5 version is newer than the published fixes for the [malformed-URL authentication bypass](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7) and [proxy hop-count spoofing](https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2). The reviewed runtime uses Node 24.21.0; follow [Node's security announcements](https://nodejs.org/en/blog/vulnerability) and apply future updates. Workflow pinning follows [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use), and weekly Dependabot checks maintain Docker and action references.

## Migration and mapping follow-up — 0.4.0

The 0.4.0 migration and manual-mapping changes received an additional focused source review and fixture regressions. Mapping records and playlist journals are encrypted and scoped to the configured server pair; explicit destination IDs and revisions prevent queued work from silently following edits or replacement accounts. Verified Discord IDs, rather than free-text labels, authorize differing-name links. Browser logout clears mapping data, and upstream user/item objects are projected before preview responses.

Detailed writes allow only portable user-data fields and refresh destination activity before merging. New-account preference copying uses an allowlist, and profile images use fixed authenticated endpoints with raster, size, and dimension checks. Imported playlists set private visibility, owner, and all matched entries in one request; subsequent runs never append to potentially shared copies. Uncertain creation is journaled before the request and requires review. Source playlist counts, aggregate entries, and creation payloads are bounded. These changes do not remove the deployment and native-package limitations documented above.

## Discord member discovery follow-up — 0.5.0

Member lookup is protected by the existing administrator session, origin checks, and `no-store` response headers. Searches target only the configured Discord server and return six identity-selection fields, excluding SDK objects, tokens, email addresses, avatars, and role lists. Queries are bounded to 2–64 characters, results to 25 members, and upstream waits to 20 seconds; the route allows 60 searches per source address per minute. Browser searches are debounced and cancelled on changes or unmount, and stale responses are discarded.

Search results are suggestions. Selecting a username or nickname does not bypass the existing fresh Discord ID, membership, account ownership, or mapping-revision checks before saving a verified mapping, provisioning an account, or delivering credentials. Automatic MEE6 username resolution accepts only a unique exact actual username from a complete search; display names and nicknames never establish ownership. Username-only announcements still cannot prove historical ownership after a rename or reuse, so durable IDs and current membership roles remain the reliable lifecycle sources.

All 580 fixture tests, the production build, and local hardened demo/fresh-container smoke checks passed. The full npm dependency audit reported no advisories. This follow-up used synthetic identities and did not contact a live Discord server; the native-package and deployment limitations above remain applicable.

## Account roles follow-up — 0.6.0

Jellyport account roles are settings presets, not additional operator permissions. Managing or applying them requires the existing enabled Jellyfin administrator session, with the same authorization, origin/CSRF, and `no-store` boundaries as other protected API routes. A role import reads fixed authenticated Jellyfin user and display-preference endpoints. Only bounded, explicitly supported policy, configuration, and display fields are retained; arbitrary custom preference keys, authentication providers, passwords, PINs, login counters, disabled state, and administrator escalation are excluded. Import requires an enabled non-administrator source account and does not mutate it.

Roles and account-role assignments are encrypted, bound to the paired Jellyfin server URL and identity, and independent of the import source after saving. Each account has one assigned role. Saving, replacing, or assigning a role causes no remote settings write. Applying requires an explicit set of setting groups and up to 100 selected accounts. The queued job pins the role revision, assignment revision, server identity, and target user identity, then rechecks them before each section is written. Administrator, disabled, template, renamed, and replacement targets are refused. Role policy updates preserve current account-specific and authentication fields; display updates merge only the supported preference allowlist.

Default roles apply only during new-account provisioning and take precedence over portable Emby preferences. Existing-account migrations retain their permissions and preferences. Changing a default or saved role while work is queued does not silently redirect that work to another revision. Supported home settings are applied through server-backed Jellyfin Web preferences; the app neither imports arbitrary Emby client dictionaries nor claims control over device-local TV/mobile settings.

The browser renders snapshots, names, and import warnings as escaped text without a raw JSON editor or browser-storage persistence. Loading, import, and mutation requests are aborted on unmount, and late responses cannot restore private role data or trigger success callbacks after sign-out. Application state records successful section revisions; it does not continuously compare live settings or enforce later changes. A successful record does not prove that a user has not subsequently edited their Jellyfin preferences. This follow-up preserves the host, backup, upstream-server, and native-package limitations documented above.

All 707 fixture tests, the production build, and local hardened demo/fresh-container smoke checks passed. Browser verification covered importing, saving, assigning, selectively applying, and choosing a template-free default role using isolated simulated servers. The full npm dependency audit reported no advisories. No production accounts, media servers, Discord memberships, or billing services were contacted or changed.

## Deployment boundaries that remain important

Keep the administration interface on a trusted LAN or VPN, or behind an HTTPS reverse proxy with restricted access. Configure `JELLYPORT_ALLOWED_HOSTS` for the proxy hostname. Preserve Host headers and keep the raw application port private. Forwarded client addresses are not trusted; requests through one proxy share its peer address for rate limits.

Restrict the data mount to the intended service user, protect backups, and retain the database and matching encryption key together. Never mount the Docker socket or unrelated host directories into Jellyport. Use a separate empty directory for demo mode. If an administrator session, service key, bot token, host, or backup is compromised, revoke the affected credentials at their issuing services and investigate the data exposure; at-rest encryption and HttpOnly cookies cannot undo that compromise.

This review did not assess the deployed firewall, NAS permissions, reverse-proxy configuration, TLS certificates, backup storage, or the security of Jellyfin, Emby, Discord, MEE6, or Stripe themselves. Passive scanner results and regression tests reduce specific risks without proving that an installation is immune to data leaks, denial of service, or unknown vulnerabilities.
