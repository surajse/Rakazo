# Rakazo Mobile

Expo (React Native + TypeScript) mobile app for **Rakazo** — the self-hosted AI bot
platform. It talks to the same backend as the web and desktop apps: chat with your
bots and handle approvals on the go.

## Requirements

- Node.js 22.13+ (24 recommended)
- The Rakazo backend running and reachable from the device
- Expo Go (for quick testing) or a development build (for push notifications)

## Run it

```bash
cd mobile
npm install
npx expo start
```

Then scan the QR code with Expo Go, or press `a` / `i` for an emulator.

### Point the app at your backend

The app defaults to `http://localhost:8000`. That only works on iOS/Android
**simulators** (they share the host loopback). On a **physical phone** you must use
your computer's LAN IP instead:

1. Open the app and sign in (or go to Settings).
2. Settings → **Server** → API base URL → e.g. `http://192.168.1.10:8000`.
3. Save, then pull-to-refresh the bot list.

Make sure your backend binds to `0.0.0.0` (not just `127.0.0.1`) and that your
firewall allows inbound connections on port 8000.

## Project layout

```
src/
  app/                 # expo-router routes (file-based navigation)
    _layout.tsx        # root: providers, auth gate, notification wiring
    (auth)/           # login, signup
    (tabs)/           # Bots · Approvals · Settings
    bot/[id].tsx       # chat screen: one ongoing thread per bot
  api/
    client.ts          # typed API client: JWT + auto-refresh, SSE streaming
    types.ts           # backend API contract types
  store/
    auth.tsx           # session: tokens in SecureStore, base URL in AsyncStorage
    approvals.tsx      # pending-approval count for the tab badge (30s poll)
    notifications.ts   # push setup (stubbed backend registration)
  components/          # BotCard, MessageBubble, ToolCallRow, Composer, …
  theme.ts             # brand tokens: #FDFDFD / #2563EB / #FF5F57
```

## How it works

- **Auth** — access + refresh tokens are stored in `expo-secure-store`
  (Keychain / Keystore). Every request attaches the access token; on 401 the
  client refreshes once and retries. Concurrent 401s share one refresh call.
- **Chat streaming** — `POST /api/bots/{id}/thread/messages` starts a run, then
  `GET …/stream?run_id=` is consumed with `expo/fetch` (`response.body.getReader()`
  + `TextDecoder`), which supports true streaming on the New Architecture.
  Events handled: `token`, `tool_call`, `tool_result`, `approval_request`,
  `done`, `error`. The parser tolerates `event:`/`data:` framing and data-only
  JSON payloads. Token appends are batched (~60ms) to keep the list smooth.
- **Stop** — the composer shows Stop while streaming: it aborts the reader and
  calls `POST /api/bots/{id}/runs/{run_id}/cancel` (best-effort).
- **Pagination** — `GET …/messages?before=&limit=` loads older messages as you
  scroll (inverted FlatList).
- **Approvals** — pending list with Approve/Deny; the tab badge refreshes on
  screen focus and every 30s while signed in. Approval requests arriving
  mid-stream also show as inline system notices.
- **Bot settings sheet** — edit name + routines markdown (via `PATCH
  /api/bots/{id}`; the sheet explains itself if the backend doesn't implement
  it), and add/delete memory notes via `/api/bots/{id}/memory`.

## Push notifications (stubbed)

`src/store/notifications.ts` is push-ready:

- `ensurePushPermission()` / `getExpoPushToken()` — permission flow + token.
- `wireNotificationResponses(navigate)` — taps deep-link to
  `/(tabs)/approvals` or `/bot/<id>` when the payload carries
  `data: { route: "…" }`.
- `registerPushTokenWithBackend(token)` — **not wired**: the current API
  contract has no push-registration endpoint. When the backend adds one (e.g.
  `POST /api/me/push-tokens { token, platform }`), call it from there.

Push delivery needs a dev/EAS build with FCM/APNs credentials — it does not
work in Expo Go on Android (SDK 53+).

## Build with EAS

```bash
npx eas-cli@latest login
npx eas-cli@latest build:configure   # creates eas.json
npx eas-cli@latest build --profile development --platform ios
npx eas-cli@latest build --profile development --platform android
```

For store builds, use `--profile production` and then
`npx eas-cli@latest submit`. OTA updates: `npx eas-cli@latest update`.

## Checks

```bash
npx tsc --noEmit   # typecheck
npx expo lint      # lint
npx expo-doctor    # diagnose dependency/config issues
```

## Notes

- No secrets are committed: tokens live only in SecureStore on-device, and the
  base URL in AsyncStorage. Nothing sensitive is logged.
- The provider list in Settings reads `GET /api/providers` (best-effort; falls
  back to an empty state when the backend doesn't expose it).
