# Rakazo Desktop

Native companion app for [Rakazo](https://github.com/surajse/Rakazo) — the self-hosted AI bot platform.
It is a **menubar/tray companion**, not a wrapped website: it lives in your system tray, summons a
compact quick-chat popup anywhere with a global hotkey, and shows native OS notifications when a bot
needs approval or finishes a run.

Built with **Electron + TypeScript + Vite** (electron-vite). The renderer is vanilla TS + CSS —
no framework — styled with the Rakazo calm-light design system.

## What it does

- **Shell window** — loads the Rakazo web app (`webUrl`, default `http://localhost:5173`). If the
  web app isn't reachable, it falls back to a local **setup screen** with steps to start the backend
  and web app, plus sign-in.
- **Tray / menubar** — left-click toggles the quick-chat popup; right-click opens the menu
  (Open Rakazo, Quick chat, Settings, Check approvals now, Quit).
- **Quick chat popup** — small frameless window (400×600) for fast questions to your default bot:
  one ongoing thread per bot, SSE streaming, pending-approval cards with inline Approve/Deny.
- **Global hotkey** — `Ctrl+Shift+R` (macOS: `⌘⇧R`) summons quick chat from anywhere.
- **Notifications** — polls `GET /api/approvals?status=pending` every 30s; new approvals and
  finished runs raise OS notifications. Clicking one opens the relevant bot.
- **Settings** — API URL, web URL, sign-in/out, launch at login, start minimized to tray,
  always-on-top popup. The JWT is stored **encrypted in the OS keychain** via
  `safeStorage` (Keychain / DPAPI / libsecret) and never leaves the main process.
- **Deep links** — `rakazo://bot/<id>` opens that bot's quick chat (single-instance app).

## Backend API contract

The app speaks the same contract as the web app (Bearer JWT):

| Call | Used for |
|---|---|
| `POST /api/auth/login` | sign-in (token → OS keychain) |
| `GET /api/bots` | bot list |
| `GET /api/bots/{id}/thread` | message history |
| `POST /api/bots/{id}/thread/messages` | send → returns `run_id` |
| `GET /api/bots/{id}/thread/messages/stream?run_id=` | SSE token stream (fetched in main so the `Authorization` header can be attached) |
| `GET /api/approvals?status=pending` | approval polling |
| `POST /api/approvals/{id}/approve` · `/deny` | approve / deny |

## Develop

Prerequisites: Node 20+, npm. The Rakazo backend (`http://localhost:8000`) and web app
(`http://localhost:5173`) should be running for full functionality — see the setup screen otherwise.

```bash
cd ~/workspace/rakazo/desktop
npm install
npm run dev        # Electron with hot reload (renderer dev server on :5199)
```

The renderer dev server intentionally uses **port 5199** so it doesn't clash with the Rakazo web
app's dev server on 5173.

```bash
npm run typecheck  # tsc for main/preload + renderer
npm run build      # production bundle into out/
```

## Package

```bash
npm run dist        # current OS
npm run dist:mac    # .dmg (arm64 + x64)
npm run dist:win    # .exe installer (nsis)
npm run dist:linux  # .AppImage
```

Artifacts land in `release/`. Icons: `npm run icons` regenerates `assets/icon.png`,
`tray.png`, `tray@2x.png` from a dependency-free Node script.

### App icons

`electron-builder.yml` references `assets/icon.icns` (macOS) and `assets/icon.ico` (Windows),
which are **not** committed. Generate them from `assets/icon.png` (256px) before a release, e.g.:

```bash
# one option — electron-icon-builder (needs ImageMagick/GraphicsMagick)
npx electron-icon-builder --input=./assets/icon.png --output=./assets
```

Without them, builds fall back to Electron's default icon but still work.

### Code signing (unsigned dev builds)

These builds are **unsigned on purpose** — fine for local/self-hosted use:

- **macOS**: first launch needs right-click → Open (Gatekeeper). `hardenedRuntime`/`notarize`
  are disabled in `electron-builder.yml`. For distribution, set up an Apple Developer ID,
  then enable `hardenedRuntime: true`, `notarize: true`, and provide `CSC_LINK`/`CSC_KEY_PASSWORD`
  (or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) to electron-builder.
- **Windows**: SmartScreen will warn on the unsigned `.exe`. For distribution, buy a code-signing
  certificate and set `CSC_LINK`/`CSC_KEY_PASSWORD` (win `certificateFile`/`certificatePassword`).
- **Linux**: AppImage needs no signing; mark executable and run.

## Project layout

```
desktop/
  src/main/        # main process
    index.ts       # lifecycle, single instance, rakazo:// deep links
    windows.ts     # shell / quick-chat / settings windows
    tray.ts        # menubar tray + menu
    hotkey.ts      # global Ctrl/Cmd+Shift+R
    notifier.ts    # approval polling + OS notifications
    ipc.ts         # renderer bridge handlers (token never leaves main)
    api.ts         # typed backend client + SSE stream reader
    store.ts       # config + keychain token (safeStorage) + auto-launch
  src/preload/     # context-isolated window.rakazo bridge
  src/shared/      # API + bridge types shared by main/preload/renderer
  src/renderer/    # vanilla TS views: quick chat, setup, settings
  assets/          # icons (icon.png, tray.png, tray@2x.png)
  scripts/         # gen-icons.mjs (zero-dependency icon generator)
```

## Security notes

- Context isolation is on and Node integration is off: the renderer has no Node access —
  everything goes through the typed `window.rakazo` preload bridge. (The renderer sandbox is
  disabled because Electron cannot load ESM preload bundles in sandboxed renderers — this matches
  the official electron-vite template.)
- The JWT is encrypted with `safeStorage` before hitting disk. `window.rakazo` exposes
  `login`/`logout`/`hasToken`, never the token itself.
- `openExternal` only allows `http(s)` URLs; the shell window opens external links in the
  system browser.
- No secrets are committed — `config.json`/`token.bin` live in the OS user-data dir, gitignored.
