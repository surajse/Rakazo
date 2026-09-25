# Self-hosting Rakazo

This guide covers running Rakazo on your own server (VPS or home lab),
putting HTTPS in front of it, backing up data, and upgrading safely.

## Prerequisites

- Linux server with Docker Engine + the Compose plugin (`docker compose version`)
- A domain name pointing at the server (for HTTPS)
- Enough disk for Postgres data, bot sandboxes, and the `rakazo-data` volume

## 1. Deploy on a server

```bash
git clone <repo-url> rakazo
cd rakazo
./install.sh
```

`install.sh` checks for Docker/Compose, curl, and openssl, creates `.env`
from `.env.example` (generating a random `JWT_SECRET`), and runs
`docker compose up -d --build`.

On boot the API container:

1. Runs Alembic migrations (`alembic upgrade head`) against Postgres.
2. Generates a Fernet key if `RAKAZO_FERNET_KEY` is unset and persists it to
   `/data/.fernet_key` on the `rakazo-data` volume.
3. Seeds the 8 bot templates.

For production, edit `.env` before first boot:

- Set `CORS_ORIGINS` to your real origins (comma-separated), not `*`.
- You may pin a stable `JWT_SECRET` — but keep it secret; changing it later
  invalidates all existing sessions.

## 2. HTTPS via Caddy reverse proxy

Caddy is the simplest way to terminate TLS: it fetches and renews
Let's Encrypt certificates automatically.

Install Caddy on the host (not in the Rakazo stack), then create
`/etc/caddy/Caddyfile`:

```
rakazo.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Then:

```bash
sudo systemctl reload caddy
```

Notes:

- Keep `8000` firewalled to localhost if Caddy runs on the same host, or bind
  the Compose port to `127.0.0.1:8000` in `docker-compose.yml`.
- The web client (`web/`) and mobile app should point at the HTTPS API URL.
- If you also serve the `web/` build statically, add a second site block
  pointing at it and keep API calls on the same origin to avoid CORS issues.

## 3. Backups

Rakazo stores data in two named Docker volumes:

- `pgdata` — Postgres: users, bots, threads, messages, memory, audit log.
- `rakazo-data` — the Fernet key (`/data/.fernet_key`) that encrypts stored
  provider API keys. **Without this key, saved provider keys cannot be
  decrypted — back it up too.**

Back up both volumes on a schedule (example: nightly cron):

```bash
# Stop writes briefly for a consistent snapshot
docker compose stop api

docker run --rm \
  -v rakazo_pgdata:/src_pgdata:ro \
  -v rakazo_rakazo-data:/src_data:ro \
  -v /backups:/dest \
  alpine \
  sh -c 'tar -czf /dest/rakazo-backup-$(date +%F).tar.gz /src_pgdata /src_data'

docker compose start api
```

Restore: stop the stack, unpack the archive over the volumes, start the stack.

Keep several generations off-server. Test a restore at least once.

## 4. Upgrades

```bash
cd rakazo
git pull
docker compose up -d --build
```

Alembic migrations run automatically on API container boot, so schema changes
apply themselves — no manual migration step. Watch the API logs the first
time you upgrade:

```bash
docker compose logs -f api
```

Rollback: `git checkout <previous-tag>` then `docker compose up -d --build`.
Note that migrations are forward-only; rolling back past a migration that
changed the schema may require restoring a backup.

## 5. Operational notes

- Health check: `GET /api/health` (also used by the stack itself).
- Logs: `docker compose logs -f` (or `docker compose logs -f api`).
- The API container mounts `/var/run/docker.sock` so the built-in
  `local_docker` sandbox can spawn a real container per bot session. Treat
  this like root-equivalent access on the host — see
  [security.md](security.md).
- Resource limits: consider setting `deploy.resources.limits` for sandbox
  workloads on shared servers.
