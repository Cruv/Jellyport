# Security

Keep Jellyport on the current release and keep its host, container runtime, and linked media servers updated. Security corrections are developed on `main`; release images are published after the repository's checks and image smoke tests pass.

Report suspected vulnerabilities privately through the repository's [Security tab](https://github.com/Cruv/Jellyport/security). If private reporting is unavailable, open an issue requesting a private reporting channel without including exploit details, credentials, or user data.

Include the Jellyport image revision, a description of the affected behavior, its prerequisites and potential impact, and reproduction steps using synthetic data. Do not attach `jellyport.db`, `secret.key`, real passwords, API keys, bot tokens, session cookies, or unredacted production logs. Never test against another person's server or accounts without authorization.

Deployment assumptions, reviewed safeguards, known limitations, and the October 2026 review are documented in [the security review](docs/security-review.md). That review is a focused source and passive-check assessment, not a guarantee that all vulnerabilities have been found.
