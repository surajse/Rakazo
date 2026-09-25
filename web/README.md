# Rakazo Web

The main interface of Rakazo — a self-hosted AI bot platform (open source Grok
alternative). React 18 + TypeScript + Vite + react-router + Zustand + Tailwind CSS.

## What it is

- **Bots dashboard** — card grid of bots with status, template, sub-bot badges, last activity.
- **Chat thread** — one ongoing thread per bot, markdown rendering, streaming
  responses over SSE, tool-call activity as expandable rows (shell commands + output,
  file ops, approvals), stop button, and infinite scroll-up history pagination.
- **New bot wizard** — pick a template (or blank), connect/choose a model provider
  (presets for OpenAI, Anthropic, Ollama, Groq, OpenRouter), pick a sandbox
  (kinds loaded from the API), write routines in Markdown.
- **Bot settings** — system prompt, routines editor, model/sandbox assignment,
  key/value memory editor, danger zone.
- **Sub-bots** — spawn and list child bots that delegate work.
- **Approvals inbox** — pending approval cards with Approve/Deny, plus history.
- **Audit log** — filterable table of every recorded action.
- **Settings** — model provider CRUD, sandbox CRUD, account info.

## Requirements

- Node.js 18+ and npm
- A running Rakazo backend API (default `http://localhost:8000`)

## Run

```bash
npm install
npm run dev        # dev server on http://localhost:5173
```

Production build:

```bash
npm run build      # type-checks, then emits dist/
npm run preview    # serve the dist/ build locally
```

## Environment variables

| Variable       | Default                 | Description              |
| -------------- | ----------------------- | ------------------------ |
| `VITE_API_URL` | `http://localhost:8000` | Base URL of the API      |

Copy `.env.example` to `.env` to override:

```bash
cp .env.example .env
```

## API contract

All calls go to `<VITE_API_URL>/api`, with `Authorization: Bearer <access_token>`.
Tokens are stored in `localStorage` (`rakazo_access_token`, `rakazo_refresh_token`).

- `POST /api/auth/signup {email,password,name}`, `POST /api/auth/login`,
  `POST /api/auth/refresh`, `GET /api/me`
- `GET/POST/PATCH/DELETE /api/model-providers`
- `GET /api/sandbox-kinds`, `GET/POST/DELETE /api/sandboxes`
- `GET /api/templates`
- `GET/POST /api/bots`, `GET/PATCH/DELETE /api/bots/{id}`
- `GET /api/bots/{id}/thread`, `GET /api/bots/{id}/thread/messages?before=&limit=`
- `POST /api/bots/{id}/thread/messages {content}` → `{message, run_id}`
- `GET /api/bots/{id}/thread/messages/stream?run_id=` (SSE: `token`, `tool_call`,
  `tool_result`, `approval_request`, `done`, `error`)
- `POST /api/bots/{id}/runs/{run_id}/cancel`
- `GET/POST /api/bots/{id}/subbots`, `GET/POST/DELETE /api/bots/{id}/memory`
- `GET /api/approvals?status=pending`, `POST /api/approvals/{id}/approve|deny`
- `GET /api/audit?bot_id=&limit=100`

Behavior notes:

- On a `401`, the client calls `/api/auth/refresh` once and retries the request.
  If refresh fails, the user is effectively logged out (token cleared → login screen).
- SSE uses `fetch` + streaming reader because `EventSource` cannot send an
  `Authorization` header.
- If the backend is unreachable, the app still builds and loads; pages show a
  "Backend unreachable / cannot reach API" empty state with a Retry button instead
  of crashing.

## Design language

Calm, modern, trustworthy: `#FDFDFD` background, `#2563EB` primary blue,
`#FF5F57` red accent (`#B42318` links), `#3D3D3D` body text, `#EFEFEF` soft
borders, 14px rounded cards, soft shadows, generous whitespace. Headings in
Space Grotesk (Aeonik stand-in), body in Inter (Geist stand-in). No emojis in the UI.
