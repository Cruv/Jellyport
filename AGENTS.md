# Jellyport repository instructions

Jellyport is a TypeScript app: React/Vite, Fastify on Node.js, SQLite, and an
optional Discord bot. `package.json` defines supported Node versions and commands.
Start with working-tree status and relevant recent history; preserve foreign edits
and paused work. Read the affected implementation and task-specific references,
not the entire documentation tree.

## Boundaries and owner preferences

- Preserve authentication, privacy, reliable identity matching, newer destination
  activity, persistence compatibility and uncertain-operation recovery. Keep real
  credentials, sessions, user history, backups and owner-specific paths out of
  commits and test fixtures. See [SECURITY.md](SECURITY.md).

- After committing and pushing completed work, merge its pull request as part of
  the same task. This is the owner's standing preference; no additional merge
  confirmation is needed unless a later instruction explicitly requests otherwise.
- Use the repository's normal squash merge after required checks pass and the
  branch is up to date. Resolve failures or conflicts before merging; report any
  blocker rather than bypassing protections.
- This preference authorizes the normal image-publication workflow triggered by
  eligible runtime changes. Production deployment, live migration trials,
  production load tests and media-server restarts require separate authorization.
  Local demos, synthetic tests and explicitly authorized read-only backup
  inspection do not require an additional approval.

## Task routing

Use [development procedures](docs/development.md) for proportional verification,
evidence reuse, release gates and resumption. Other AI clients should reference
this file rather than duplicate its policy; no repository-local skills or other
client adapters currently exist.

- UI: `frontend/src/`; API/startup: `server/index.ts` and `server/main.ts`.
- Migration, matching and snapshots: [capabilities](docs/migration-capabilities.md),
  [workload safety](docs/performance-safety.md), and
  [plugin backups](docs/emby-plugin-backups.md), as relevant.
- Containers and operating data: [deployment](docs/docker-deployment.md).
- Discord and access automation: [Discord setup](docs/discord-setup.md).
- Security changes: [security review and limitations](docs/security-review.md).
