import type { AppConfig } from '../../../shared/types'

const r = window.rakazo

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function toggleRow(label: string, desc: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el('div', 'row')
  row.style.padding = '10px 0'
  row.style.borderBottom = '1px solid var(--line)'
  const left = el('div')
  left.innerHTML = `<div style="font-weight:600">${label}</div><div class="small muted">${desc}</div>`
  const t = el('label', 'toggle')
  const input = el('input') as HTMLInputElement
  input.type = 'checkbox'
  input.checked = initial
  const track = el('span', 'track')
  t.append(input, track)
  input.addEventListener('change', () => onChange(input.checked))
  row.append(left, t)
  return row
}

/** Settings screen (#/settings). */
export function renderSettings(root: HTMLElement): () => void {
  const page = el('div', 'page')
  const inner = el('div', 'inner')
  inner.innerHTML = `
    <div class="brand">
      <div class="logo">R</div>
      <div><h1>Settings</h1><p>Rakazo desktop companion</p></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:10px">Connection</h3>
      <div class="field"><label>API URL</label><input id="api" class="mono"></div>
      <div class="field" style="margin-bottom:6px"><label>Web app URL</label><input id="web" class="mono"></div>
      <div class="row" style="margin-top:10px">
        <span class="small muted" id="token-state">Checking sign-in…</span>
        <span>
          <button class="btn btn-sm" id="test">Test connection</button>
          <button class="btn btn-sm" id="logout">Sign out</button>
        </span>
      </div>
      <div class="notice" id="msg" style="display:none;margin-top:10px;margin-bottom:0"></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:6px">Behavior</h3>
      <div id="toggles"></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:6px">Shortcuts</h3>
      <div class="row"><span class="small">Summon quick chat from anywhere</span><span class="kbd" id="hotkey">…</span></div>
      <div class="row" style="margin-top:8px"><span class="small">Open a bot directly</span><span class="kbd mono">rakazo://bot/&lt;id&gt;</span></div>
    </div>
    <p class="small muted" style="text-align:center">Rakazo Desktop v0.1.0 · token lives in your OS keychain</p>`

  page.append(inner)
  root.append(page)

  const $ = <T extends HTMLElement>(s: string): T => inner.querySelector('#' + s) as T
  const msg = $('msg') as HTMLElement
  const showMsg = (text: string, kind: 'notice-ok' | 'notice-error' | 'notice-info'): void => {
    msg.className = `notice ${kind}`
    msg.style.display = 'block'
    msg.style.marginTop = '10px'
    msg.style.marginBottom = '0'
    msg.textContent = text
  }

  let cfg: AppConfig

  const saveSoon = (() => {
    let t: number | undefined
    return () => {
      window.clearTimeout(t)
      t = window.setTimeout(async () => {
        cfg = await r.setConfig({
          apiUrl: ($('api') as HTMLInputElement).value.trim() || cfg.apiUrl,
          webUrl: ($('web') as HTMLInputElement).value.trim() || cfg.webUrl
        })
      }, 600)
    }
  })()

  $('api').addEventListener('input', saveSoon)
  $('web').addEventListener('input', saveSoon)

  $('test').addEventListener('click', async () => {
    showMsg('Testing…', 'notice-info')
    const res = await r.testConnection()
    showMsg(res.ok ? 'Connected — API reachable and token valid.' : `Failed: ${res.error}`, res.ok ? 'notice-ok' : 'notice-error')
  })
  $('logout').addEventListener('click', async () => {
    await r.logout()
    await refreshTokenState()
    showMsg('Signed out. Token removed from the keychain.', 'notice-info')
  })

  async function refreshTokenState(): Promise<void> {
    const has = await r.hasToken()
    $('token-state').textContent = has ? '● Signed in (token in OS keychain)' : '○ Not signed in'
    ;($('token-state') as HTMLElement).style.color = has ? 'var(--ok)' : 'var(--muted)'
  }

  void (async () => {
    cfg = await r.getConfig()
    ;($('api') as HTMLInputElement).value = cfg.apiUrl
    ;($('web') as HTMLInputElement).value = cfg.webUrl
    $('hotkey').textContent = (await r.getHotkey()).replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    await refreshTokenState()

    const toggles = $('toggles') as HTMLElement
    toggles.append(
      toggleRow('Launch at login', 'Start Rakazo when you sign in to your computer.', cfg.autoLaunch, (v) => {
        void r.setAutoLaunch(v)
      }),
      toggleRow('Start minimized', 'Launch quietly to the tray instead of opening a window.', cfg.startMinimized, async (v) => {
        cfg = await r.setConfig({ startMinimized: v })
        // re-apply auto-launch hidden flag
        if (cfg.autoLaunch) await r.setAutoLaunch(true)
      }),
      toggleRow('Quick chat always on top', 'Keep the popup above other windows.', cfg.alwaysOnTop, (v) => {
        void r.setAlwaysOnTop(v)
      })
    )
    const last = toggles.lastElementChild as HTMLElement
    if (last) last.style.borderBottom = 'none'
  })()

  return () => undefined
}
