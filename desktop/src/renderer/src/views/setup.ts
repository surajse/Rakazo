import type { AppConfig } from '../../../shared/types'

const r = window.rakazo

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function dot(state: 'ok' | 'bad' | 'wait'): string {
  return `<span class="status-dot ${state}"></span>`
}

/** Setup / connection screen (#/setup). Shown when the web app is unreachable. */
export function renderSetup(root: HTMLElement): () => void {
  const disposers: Array<() => void> = []
  const page = el('div', 'page')
  const inner = el('div', 'inner')

  inner.innerHTML = `
    <div class="brand">
      <div class="logo">R</div>
      <div><h1>Rakazo</h1><p>Your self-hosted AI teammates</p></div>
    </div>
    <div class="card" id="status-card">
      <h3 style="margin-bottom:10px">Connection status</h3>
      <div class="row" style="margin-bottom:8px"><span>${dot('wait')}<b>Web app</b></span><span class="small muted mono" id="web-url"></span></div>
      <div class="row"><span>${dot('wait')}<b>API</b></span><span class="small muted mono" id="api-url"></span></div>
      <div class="notice notice-info" id="status-note" style="display:none;margin-top:12px;margin-bottom:0"></div>
    </div>
    <div class="card" id="how-card" style="display:none">
      <h3 style="margin-bottom:10px">Start Rakazo locally</h3>
      <div class="steps">
        <div class="step"><div class="n">1</div><div>Start the backend (API + Postgres):<br><code>cd ~/workspace/rakazo && docker compose up</code></div></div>
        <div class="step"><div class="n">2</div><div>Start the web app:<br><code>cd ~/workspace/rakazo/web && npm install && npm run dev</code></div></div>
        <div class="step"><div class="n">3</div><div>Sign in below with your Rakazo account, then press <span class="kbd">Retry</span>.</div></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="btn btn-primary" id="retry">Retry connection</button>
        <button class="btn" id="open-settings">Settings</button>
      </div>
    </div>
    <div class="card" id="ready-card" style="display:none">
      <h3 style="margin-bottom:6px">You're connected 🎉</h3>
      <p class="small muted" style="margin-bottom:12px">The web app is reachable. Open it as the main interface, or use quick chat from the tray.</p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="open-app">Open web app</button>
        <button class="btn" id="open-quick">Quick chat</button>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:4px">Sign in</h3>
      <p class="small muted" style="margin-bottom:12px">Your token is stored encrypted in the OS keychain — never in plain text.</p>
      <div class="field"><label>API URL</label><input id="api" class="mono"></div>
      <div class="field"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="pass" type="password" autocomplete="current-password"></div>
      <div class="notice notice-error" id="err" style="display:none"></div>
      <div class="notice notice-ok" id="ok" style="display:none"></div>
      <button class="btn btn-primary" id="login" style="width:100%">Sign in</button>
    </div>`

  page.append(inner)
  root.append(page)

  const $ = <T extends HTMLElement>(s: string): T => inner.querySelector('#' + s) as T
  const webUrlEl = $('web-url') as HTMLElement
  const apiUrlEl = $('api-url') as HTMLElement
  const note = $('status-note') as HTMLElement
  const howCard = $('how-card') as HTMLElement
  const readyCard = $('ready-card') as HTMLElement
  const errBox = $('err') as HTMLElement
  const okBox = $('ok') as HTMLElement
  const apiInput = $('api') as HTMLInputElement
  const loginBtn = $('login') as HTMLButtonElement

  let cfg: AppConfig

  const setRow = (id: 'web-url' | 'api-url', okState: 'ok' | 'bad' | 'wait', label: string): void => {
    const rowEl = id === 'web-url' ? webUrlEl : apiUrlEl
    const row = rowEl.parentElement as HTMLElement
    const labelSpan = row.firstElementChild as HTMLElement
    labelSpan.innerHTML = `${dot(okState)}<b>${id === 'web-url' ? 'Web app' : 'API'}</b>`
    rowEl.textContent = label
  }

  async function check(): Promise<void> {
    setRow('web-url', 'wait', cfg.webUrl)
    setRow('api-url', 'wait', cfg.apiUrl)
    howCard.style.display = 'none'
    readyCard.style.display = 'none'
    note.style.display = 'none'

    const [webOk, apiRes] = await Promise.all([r.probeWeb(cfg.webUrl), r.testConnection()])
    setRow('web-url', webOk ? 'ok' : 'bad', cfg.webUrl)
    setRow('api-url', apiRes.ok ? 'ok' : 'bad', cfg.apiUrl)

    if (webOk) {
      readyCard.style.display = 'block'
      note.style.display = 'block'
      note.className = 'notice notice-ok'
      note.style.marginTop = '12px'
      note.style.marginBottom = '0'
      note.textContent = apiRes.ok
        ? 'Web app and API are both reachable. You are signed in.'
        : 'Web app is reachable. Sign in below to connect the desktop companion.'
    } else {
      howCard.style.display = 'block'
      note.style.display = 'block'
      note.className = 'notice notice-info'
      note.style.marginTop = '12px'
      note.style.marginBottom = '0'
      note.textContent = "The web app isn't running yet — follow the steps below, then retry."
    }
  }

  async function doLogin(): Promise<void> {
    const email = ($('email') as HTMLInputElement).value.trim()
    const pass = ($('pass') as HTMLInputElement).value
    errBox.style.display = 'none'
    okBox.style.display = 'none'
    loginBtn.disabled = true
    const res = await r.login(email, pass)
    loginBtn.disabled = false
    if (!res.ok) {
      errBox.textContent = res.error ?? 'Login failed.'
      errBox.style.display = 'block'
      return
    }
    okBox.textContent = 'Signed in. Token stored in your OS keychain.'
    okBox.style.display = 'block'
    await check()
  }

  $('retry').addEventListener('click', () => void check())
  $('open-settings').addEventListener('click', () => r.openSettings())
  $('open-app').addEventListener('click', () => r.openMain())
  $('open-quick').addEventListener('click', () => {
    location.hash = '#/quick'
    r.toggleQuickChat()
  })
  loginBtn.addEventListener('click', () => void doLogin())
  $('pass').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doLogin()
  })
  apiInput.addEventListener('change', async () => {
    cfg = await r.setConfig({ apiUrl: apiInput.value.trim() || cfg.apiUrl })
    await check()
  })
  disposers.push(() => undefined)

  void (async () => {
    cfg = await r.getConfig()
    apiInput.value = cfg.apiUrl
    await check()
  })()

  return () => disposers.forEach((d) => d())
}
