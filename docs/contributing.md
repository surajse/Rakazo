# Contributing to Rakazo

Thanks for helping build an open-source AI platform you can actually own.
Issues and pull requests are welcome.

## Repo layout

```
docker-compose.yml   # db (postgres:16) + api (build ./backend); named volumes pgdata, rakazo-data
.env.example         # all backend config knobs
install.sh           # one-command installer (Docker path)
backend/             # FastAPI app: REST + SSE API, SQLAlchemy 2 models, Alembic migrations
web/                 # React + Vite client
desktop/             # Electron desktop companion
mobile/              # Expo mobile app
landing/             # static landing page
docs/                # these docs
```

The API contract is defined by the Pydantic v2 schemas in
`backend/app/schemas.py` and the routers in `backend/app/routers/`
(auth, providers, sandboxes, templates, bots, approvals, audit, health).

## Working on the backend

The backend is FastAPI with SQLAlchemy 2 (async), Alembic migrations against
Postgres, and a pytest suite that uses SQLite plus mocked model + sandbox
clients — **no Docker needed to run tests**.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
.venv/bin/python -m pytest -q
```

Run the API locally without Docker:

```bash
cd backend
export DATABASE_URL="postgresql+asyncpg://rakazo:rakazo@localhost:5432/rakazo"
export JWT_SECRET="dev-secret" FERNET_KEY_FILE="./.fernet_key"
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

### Adding a migration

Change the SQLAlchemy models in `backend/app/models.py`, then from
`backend/`:

```bash
alembic revision --autogenerate -m "describe the change"
```

Review the generated file in `backend/alembic/versions/` carefully before
committing — autogenerate misses some things (index renames, data migrations).
Migrations run automatically on container boot (`alembic upgrade head`).

## Working on the frontends

Each client builds against the API at `http://localhost:8000` (configure the
API URL if you serve the API elsewhere).

```bash
# Web client (React + Vite)
cd web
npm install
npm run dev        # typecheck/lint: npm run lint
npm run build      # production build (tsc + vite build)

# Desktop (Electron)
cd desktop
npm install
npm run dev        # live Electron window
npm run typecheck  # tsc for node + web configs
npm run dist       # packaged installer (electron-builder)

# Mobile (Expo)
cd mobile
npm install
npm start          # Expo dev server; use the Android/iOS/Expo Go flows
npm run lint
```

## Pull request checklist

- Backend: new behavior covered by pytest tests; existing suite green.
- Frontends: `npm run build` / typecheck passes for each touched client.
- Migrations: included and reviewed if the DB schema changed.
- Docs: update `README.md` or `docs/` when the change affects setup,
  deployment, or the API contract.
- Secrets: never commit `.env`, API keys, or key material — only
  `.env.example` should change for config additions.

## Reporting bugs

Include the API logs (`docker compose logs -f api` or your local uvicorn
output), the exact request or UI steps, and what you expected. For security
issues, see [security.md](security.md) — do not open a public issue.
