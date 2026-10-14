# Repository workflow

- After committing and pushing completed work, merge its pull request as part of
  the same task. This is the owner's standing preference; no additional merge
  confirmation is needed unless a later instruction explicitly requests otherwise.
- Use the repository's normal squash merge after required checks pass and the
  branch is up to date. Resolve failures or conflicts before merging; report any
  blocker rather than bypassing protections.
- This preference authorizes the normal image-publication workflow triggered by
  merging. Production deployment, production load tests and media-server restarts
  still require separate authorization.
