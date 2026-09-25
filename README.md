# Rakazo

**Rakazo is a self-hosted AI bot platform — an open-source Grok alternative you actually own.**

Give each bot a live computer (sandbox), connect your own model (OpenAI-compatible,
Anthropic, or local Ollama), and let it do real work: run commands, work with files,
browse the web. Bots keep one ongoing thread, long-term memory, and full history.
They can spawn child bots or run short-lived helpers inside a turn. Anything risky —
installing packages, deleting files outside the workspace, contacting new network
hosts — pauses for your approval, and everything is written to an audit log.

Web, desktop, and mobile clients all talk to the same backend over one REST + SSE API.

---

## Quickstart

Requirements: Docker + Docker Compose.

```bash
cp .env.example .env        # then set JWT_SECRET to a long random value
docker compose up --build
```

- API: http://localhost:8000 (interactive docs at `/docs`)
- Health: http://localhost:8000/api/health

The API container mounts `/var/run/docker.sock` so the built-in `local_docker`
sandbox can spawn a real container per bot session. On first boot the server:

1. Runs Alembic migrations (`alembic upgrade head`) against Postgres,
2. Generates a Fernet key if `RAKAZO_FERNET_KEY` is unset and persists it to
   `/data/.fernet_key` (kept on the `rakazo-data` volume),
3. Seeds the 8 bot templates.

### Local dev without Docker

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL="postgresql+asyncpg://rakazo:rakazo@localhost:5432/rakazo"
export JWT_SECRET="dev-secret" FERNET_KEY_FILE="./.fernet_key"
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Tests (sqlite, mocked model + sandbox — no Docker needed):

```bash
cd backend && .venv/bin/python -m pytest -q
```

---

## Architecture

```
backend/
  app/
    main.py            # FastAPI app, CORS, lifespan (migrate + seed)
    config.py          # pydantic-settings (env vars)
    models.py          # SQLAlchemy 2 models (async)
    schemas.py         # Pydantic v2 API schemas (the /api contract)
    deps.py            # get_db, get_current_user (Bearer JWT)
    seed.py            # 8 bot templates
    routers/           # auth, providers, sandboxes, templates, bots, approvals, audit, health
    services/
      agent.py         # ReAct loop, tools, approval policy, spawn_bot/run_helper
      model_clients.py # litellm-based connectors (openai_compatible/anthropic/ollama)
      sandbox.py       # SandboxProvider interface + local_docker + e2b/daytona/modal stubs
      runs.py          # in-process run registry: SSE buses, cancel flags, approval waiters
      audit.py         # audit-log helper
  alembic/             # migrations (env.py reads DATABASE_URL)
  tests/               # pytest suite (mocked model + sandbox)
```

**Request flow:** `POST /api/bots/{id}/thread/messages` persists the user message,
creates a `Run`, and starts the agent loop as a background task. The loop streams
`token`, `tool_call`, `tool_result`, `approval_request`, `done`/`error` events over
SSE at `GET /api/bots/{id}/thread/messages/stream?run_id=...`.

**Auth:** email + password (bcrypt). Short-lived access JWT (15 min) + rotating
refresh JWT (30 days, stored hashed, revoked on rotation).

**Secrets:** provider API keys are encrypted with Fernet before storage and are
**never** returned by the API — only a masked preview (`sk-••••••••2345`).

**Approvals:** the agent pauses a turn and creates an `approvals` row for
package installs, file deletes outside `/workspace`, and network egress to
previously unseen hosts. `POST /api/approvals/{id}/approve|deny` resolves the
waiting turn (default timeout 15 min → denied).

**Audit log:** auth events, provider/sandbox/bot config changes, messages, run
lifecycle, tool executions, approvals, and memory changes are all recorded.
`GET /api/audit?bot_id=&limit=100`.

---

## API overview

All endpoints live under `/api`, speak JSON, and (except signup/login/refresh,
`sandbox-kinds`, and `health`) require `Authorization: Bearer <access_token>`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/signup` | `{email,password,name}` → `{user, access_token, refresh_token}` |
| POST | `/api/auth/login` | → `{user, access_token, refresh_token}` |
| POST | `/api/auth/refresh` | `{refresh_token}` → rotated pair |
| GET | `/api/me` | → `{user}` |
| GET/POST | `/api/model-providers` | list / create (key write-only, masked in responses) |
| PATCH/DELETE | `/api/model-providers/{id}` | update / delete |
| GET | `/api/sandbox-kinds` | `[{kind,name,description,configured,config_schema}]` |
| GET/POST | `/api/sandboxes` | named sandbox configs |
| DELETE | `/api/sandboxes/{id}` | delete |
| GET | `/api/templates` | the 8 seeded templates |
| GET/POST | `/api/bots` | list / create (template fills prompts) |
| GET/PATCH/DELETE | `/api/bots/{id}` | read / update / delete |
| GET | `/api/bots/{id}/thread` | `{thread, messages}` (last 50) |
| GET | `/api/bots/{id}/thread/messages?before=&limit=` | history pagination (oldest-first) |
| POST | `/api/bots/{id}/thread/messages` | `{content}` → `{message, run_id}` (starts run) |
| GET | `/api/bots/{id}/thread/messages/stream?run_id=` | SSE: token/tool_call/tool_result/approval_request/done/error |
| POST | `/api/bots/{id}/runs/{run_id}/cancel` | cancel a running turn |
| GET/POST | `/api/bots/{id}/subbots` | list / spawn child bot (`{name,task,template?}` → `{bot,run_id}`) |
| GET/POST | `/api/bots/{id}/memory` | list / set `{key,value}` notes |
| DELETE | `/api/bots/{id}/memory/{key}` | delete a note |
| GET | `/api/approvals?status=pending` | approval queue |
| POST | `/api/approvals/{id}/approve`, `/deny` | resolve (`{reason?}` on deny) |
| GET | `/api/audit?bot_id=&limit=100` | audit log |
| GET | `/api/health` | `{status, version, sandbox_kinds}` |

Full interactive docs: http://localhost:8000/docs

---

## Sandbox providers

`app/services/sandbox.py` defines the interface every provider implements:

```python
class SandboxProvider(ABC):
    kind: str; name: str; description: str
    def config_schema(self) -> dict: ...
    def is_configured(self) -> bool: ...
    async def create_session(self, config: dict) -> SandboxSession: ...

class SandboxSession(ABC):
    async def shell_run(command, timeout=120) -> {exit_code, stdout, stderr}
    async def file_read(path) -> {path, content} | {error}
    async def file_write(path, content) -> {path, bytes_written}
    async def file_list(path="/workspace") -> {path, entries}
    async def http_fetch(url, timeout=30) -> {url, status, body}
    async def browser_snapshot(url) -> {url, title, text}   # best-effort, no JS render
    async def destroy() -> None: ...
```

Shipped providers:

- **`local_docker`** — real per-session containers (`python:3.12-slim`) via
  docker-py on the host socket. Shell, files, and HTTP run inside the container.
- **`e2b` / `daytona` / `modal`** — stubs: they expose a config schema and report
  `configured: false`, raising a clear "not configured" error if selected.

### Adding a sandbox provider

1. Subclass `SandboxProvider` (+ `SandboxSession`) in `app/services/sandbox.py`
   (or a new module imported there).
2. Implement `config_schema()`, `is_configured()`, and `create_session()`.
3. Register it in `REGISTRY = {...}` — it immediately appears in
   `GET /api/sandbox-kinds` and becomes selectable for sandboxes. No other
   changes needed: the agent loop only talks to the `SandboxSession` interface.

`browser_snapshot` is best-effort by design (fetch + text extraction, no JS).
For full rendering, run a browser-automation sidecar and override
`browser_snapshot` in your provider.

---

## Bot templates

Seeded on startup (`app/seed.py`): **Inbox Manager, Sales Outbound, Talent Scout,
Expense Manager, Bug Triage, Account Manager, Paid Media, Chief of Staff**.
Each carries a default system prompt and plain-Markdown `routines_md` that the
bot follows; creating a bot with `template` copies both (overridable).

---

## Environment variables

| Var | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://rakazo:rakazo@localhost:5432/rakazo` | Postgres (async) |
| `JWT_SECRET` | `dev-secret-change-me` | **Set this in production** |
| `RAKAZO_FERNET_KEY` | *(auto-generated)* | Fernet key for provider API keys |
| `FERNET_KEY_FILE` | `/data/.fernet_key` | Where the auto-generated key is persisted |
| `CORS_ORIGINS` | `*` | `*` or comma-separated origins |
| `MAX_AGENT_ITERATIONS` | `25` | ReAct loop bound per turn |
| `HELPER_MAX_ITERATIONS` | `8` | Bound for `run_helper` sub-agents |
| `APPROVAL_TIMEOUT_SECONDS` | `900` | Approval wait timeout (then denied) |

---

## Security notes

- Provider API keys are Fernet-encrypted at rest; the API only ever returns a mask.
- JWT secrets and the Fernet key must be set/persisted securely in production
  (the compose setup persists the Fernet key on a Docker volume).
- The `local_docker` sandbox mounts the host Docker socket — treat the API host
  as trusted infrastructure, same as any self-hosted runner.
- Destructive tool actions require explicit user approval and are audit-logged.
