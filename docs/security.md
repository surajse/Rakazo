# Rakazo Security

Rakazo is self-hosted software that gives AI agents a live computer.
Take the security model seriously — especially on shared servers.

## Reporting vulnerabilities

- **Do not open a public issue** for a vulnerability.
- Email the maintainers privately with: what is affected, steps to
  reproduce, and your assessment of impact. Include API logs and the
  Rakazo version/commit.
- We aim to acknowledge within 72 hours and to coordinate a fix and
  disclosure timeline with you before anything goes public.

## API key handling

Provider API keys (OpenAI-compatible, Anthropic, Ollama) are encrypted at
rest with **Fernet** (AES-128 in CBC mode with HMAC):

- On first boot the API generates a Fernet key unless `RAKAZO_FERNET_KEY` is
  set, and persists it to `FERNET_KEY_FILE` (default `/data/.fernet_key`) on
  the `rakazo-data` Docker volume.
- Keys are only decrypted in memory when a provider call is made; they are
  never logged.
- **Back up the Fernet key** — if the volume is lost, stored provider keys
  cannot be recovered. See [self-hosting.md](self-hosting.md#3-backups).
- In production, prefer setting `RAKAZO_FERNET_KEY` from your own secret
  store rather than relying on the auto-generated file.

## Never commit secrets

- `.env` is git-ignored. Only `.env.example` (placeholder values) lives in
  the repo.
- `JWT_SECRET` must be a long random value in production (`openssl rand -hex 32`);
  rotating it invalidates all sessions.
- Do not paste tokens, keys, or `.env` contents into issues, logs you share,
  or screenshots.

## Sandbox and approval model

- The API container mounts `/var/run/docker.sock` so the `local_docker`
  sandbox can spawn a real container per bot session. This is powerful and
  root-equivalent on the host — only run Rakazo on machines you control, and
  consider additional hardening (user namespaces, resource limits, network
  egress controls) on shared servers.
- Anything risky the agent attempts — installing packages, deleting files
  outside the workspace, contacting new network hosts — pauses for your
  explicit approval before it runs. Approvals expire
  (`APPROVAL_TIMEOUT_SECONDS`); unapproved actions never execute.
- Every agent action is written to an append-only audit log
  (`GET /api/audit`) so you can review what a bot did and when.

## Hardening checklist for production

1. Set `CORS_ORIGINS` to your exact origins (never `*`).
2. Put HTTPS in front of the API (see `self-hosting.md`) — the login and
   token flows must never go over plain HTTP.
3. Use a strong, unique `JWT_SECRET` and `RAKAZO_FERNET_KEY`.
4. Keep Docker, the host OS, and dependencies patched; rebuild images on
   upgrade (`docker compose up -d --build`).
5. Back up `pgdata` and `rakazo-data` off-server on a schedule.
