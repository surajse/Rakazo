import type { Approval, Bot, ChatMessage } from '../../../shared/types'

const r = window.rakazo

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Quick-chat popup view (#/quick). */
export function renderQuick(root: HTMLElement): () => void {
  const disposers: Array<() => void> = []
  const on = <T extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: T,
    fn: (e: WindowEventMap[T]) => void
  ): void => {
    target.addEventListener(type, fn as EventListener)
    disposers.push(() => target.removeEventListener(type, fn as EventListener))
  }

  let bots: Bot[] = []
  let activeBotId: string | null = localStorage.getItem('rakazo:lastBot')
  let streaming = false
  let streamText = ''
  let streamEl: HTMLElement | null = null

  const wrap = el('div', 'quick')

  // ---- header (drag region, frameless window) ----
  const header = el('header')
  const logo = el('div', 'logo', 'R')
  const select = el('select')
  select.title = 'Choose bot'
  const pinBtn = el('button', 'iconbtn', '📌')
  pinBtn.title = 'Always on top'
  const settingsBtn = el('button', 'iconbtn', '⚙')
  settingsBtn.title = 'Settings'
  const closeBtn = el('button', 'iconbtn', '✕')
  closeBtn.title = 'Hide (Esc)'
  header.append(logo, select, pinBtn, settingsBtn, closeBtn)

  const approvalsBox = el('div', 'approvals')
  const messages = el('div', 'messages')
  const composer = el('div', 'composer')
  const box = el('div', 'box')
  const input = el('textarea') as HTMLTextAreaElement
  input.rows = 1
  input.placeholder = 'Ask your bot…'
  const sendBtn = el('button', 'send', '↑')
  sendBtn.title = 'Send (Enter)'
  box.append(input, sendBtn)
  const hint = el('div', 'hint small muted')
  composer.append(box, hint)
  wrap.append(header, approvalsBox, messages, composer)
  root.append(wrap)

  const setPinState = (v: boolean): void => {
    pinBtn.classList.toggle('active', v)
  }

  function scrollDown(): void {
    messages.scrollTop = messages.scrollHeight
  }

  function addMessage(m: ChatMessage): HTMLElement {
    const d = el('div', `msg ${m.role === 'user' ? 'user' : 'assistant'}`)
    const body = el('div', '', m.content)
    const meta = el('div', 'meta', m.created_at ? fmtTime(m.created_at) : '')
    d.append(body, meta)
    messages.append(d)
    scrollDown()
    return d
  }

  function showEmpty(): void {
    messages.innerHTML = ''
    const e = el('div', 'empty')
    e.innerHTML = `<div class="big">🤖</div><div><b>No messages yet</b><br><span class="small">Ask your bot anything — it has a live computer.</span></div>`
    messages.append(e)
  }

  function showError(text: string): void {
    const n = el('div', 'notice notice-error', text)
    messages.append(n)
    scrollDown()
  }

  async function loadThread(): Promise<void> {
    if (!activeBotId) return
    messages.innerHTML = ''
    try {
      const thread = await r.getThread(activeBotId)
      if (thread.length === 0) showEmpty()
      else thread.forEach(addMessage)
    } catch (err) {
      showError(`Couldn't load history: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function refreshBots(): Promise<void> {
    try {
      bots = await r.getBots()
    } catch (err) {
      showError(`Couldn't reach the API: ${err instanceof Error ? err.message : err}`)
      return
    }
    select.innerHTML = ''
    for (const b of bots) {
      const o = document.createElement('option')
      o.value = b.id
      o.textContent = b.name
      select.append(o)
    }
    if (bots.length === 0) {
      const o = document.createElement('option')
      o.textContent = 'No bots yet — create one in the web app'
      select.append(o)
      return
    }
    if (!activeBotId || !bots.some((b) => b.id === activeBotId)) {
      activeBotId = bots[0].id
    }
    select.value = activeBotId
    await loadThread()
  }

  function activeBot(): Bot | undefined {
    return bots.find((b) => b.id === activeBotId)
  }

  async function send(): Promise<void> {
    const content = input.value.trim()
    if (!content || streaming || !activeBotId) return
    input.value = ''
    input.style.height = 'auto'
    addMessage({ id: `local-${Date.now()}`, role: 'user', content, created_at: new Date().toISOString() })
    streaming = true
    streamText = ''
    sendBtn.disabled = true
    streamEl = addMessage({
      id: `stream-${Date.now()}`,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString()
    })
    streamEl.classList.add('streaming')
    const body = streamEl.firstElementChild as HTMLElement
    const off = r.onStreamEvent((evt) => {
      if (!streamEl) return
      if (evt.type === 'delta' && evt.text) {
        streamText += evt.text
        body.textContent = streamText
        scrollDown()
      } else if (evt.type === 'done' || evt.type === 'error') {
        streamEl.classList.remove('streaming')
        if (evt.type === 'error') showError(evt.text ?? 'Stream failed.')
        streamEl = null
        streaming = false
        sendBtn.disabled = false
      }
    })
    try {
      const { run_id } = await r.sendMessage(activeBotId, content)
      await r.streamStart(activeBotId, activeBot()?.name ?? 'Bot', run_id)
    } catch (err) {
      if (streamEl) {
        streamEl.classList.remove('streaming')
        streamEl = null
      }
      showError(err instanceof Error ? err.message : String(err))
      streaming = false
      sendBtn.disabled = false
    } finally {
      off()
    }
  }

  async function refreshApprovals(): Promise<void> {
    let approvals: Approval[]
    try {
      approvals = await r.getApprovals()
    } catch {
      return
    }
    approvalsBox.innerHTML = ''
    for (const a of approvals.slice(0, 3)) {
      const card = el('div', 'approval')
      card.append(el('div', 't', `⚠ Approval needed — ${a.bot_name ?? 'bot'}`))
      card.append(el('div', 'd', (a.title ?? a.kind ?? 'Approval') + (a.detail || a.description ? `\n${a.detail ?? a.description}` : '')))
      const actions = el('div', 'actions')
      const ok = el('button', 'btn btn-sm btn-primary', 'Approve')
      const no = el('button', 'btn btn-sm', 'Deny')
      ok.onclick = async () => {
        await r.decideApproval(a.id, 'approve').catch((e) => showError(String(e)))
        void refreshApprovals()
      }
      no.onclick = async () => {
        await r.decideApproval(a.id, 'deny').catch((e) => showError(String(e)))
        void refreshApprovals()
      }
      actions.append(ok, no)
      card.append(actions)
      approvalsBox.append(card)
    }
  }

  function renderLogin(): void {
    messages.innerHTML = ''
    composer.style.display = 'none'
    const w = el('div', 'login-wrap')
    w.innerHTML = `
      <div class="card">
        <h3 style="margin-bottom:4px">Sign in</h3>
        <p class="small muted" style="margin-bottom:12px">Use your Rakazo account. The token is stored in your OS keychain.</p>
        <div class="field"><label>Email</label><input id="q-email" type="email" autocomplete="username"></div>
        <div class="field"><label>Password</label><input id="q-pass" type="password" autocomplete="current-password"></div>
        <div class="notice notice-error" id="q-err" style="display:none"></div>
        <button class="btn btn-primary" id="q-go" style="width:100%">Sign in</button>
        <button class="btn btn-ghost btn-sm" id="q-setup" style="width:100%;margin-top:6px">Open setup →</button>
      </div>`
    messages.append(w)
    const go = w.querySelector<HTMLButtonElement>('#q-go')!
    const err = w.querySelector<HTMLElement>('#q-err')!
    const doLogin = async (): Promise<void> => {
      const email = w.querySelector<HTMLInputElement>('#q-email')!.value.trim()
      const pass = w.querySelector<HTMLInputElement>('#q-pass')!.value
      go.disabled = true
      const res = await r.login(email, pass)
      go.disabled = false
      if (!res.ok) {
        err.textContent = res.error ?? 'Login failed.'
        err.style.display = 'block'
        return
      }
      location.reload()
    }
    go.onclick = () => void doLogin()
    w.querySelector<HTMLInputElement>('#q-pass')!.onkeydown = (e) => {
      if (e.key === 'Enter') void doLogin()
    }
    w.querySelector<HTMLButtonElement>('#q-setup')!.onclick = () => {
      location.hash = '#/setup'
    }
  }

  // ---- events ----
  on(select, 'change', () => {
    activeBotId = select.value
    localStorage.setItem('rakazo:lastBot', activeBotId)
    void loadThread()
  })
  on(sendBtn, 'click', () => void send())
  on(input, 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  })
  on(input, 'input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`
  })
  on(pinBtn, 'click', async () => {
    const cfg = await r.getConfig()
    const next = !cfg.alwaysOnTop
    await r.setAlwaysOnTop(next)
    setPinState(next)
  })
  on(settingsBtn, 'click', () => r.openSettings())
  on(closeBtn, 'click', () => r.toggleQuickChat())
  on(window, 'keydown', (e) => {
    if (e.key === 'Escape' && !streaming) r.toggleQuickChat()
  })
  disposers.push(r.onOpenBot((botId) => {
    if (bots.some((b) => b.id === botId)) {
      activeBotId = botId
      select.value = botId
      localStorage.setItem('rakazo:lastBot', botId)
      void loadThread()
    } else {
      void refreshBots().then(() => {
        if (bots.some((b) => b.id === botId)) {
          activeBotId = botId
          select.value = botId
          void loadThread()
        }
      })
    }
  }))

  const approvalTimer = window.setInterval(() => void refreshApprovals(), 20_000)
  disposers.push(() => window.clearInterval(approvalTimer))
  disposers.push(() => void r.streamStop())

  // ---- init ----
  void (async () => {
    const [cfg, hotkey, authed] = await Promise.all([r.getConfig(), r.getHotkey(), r.hasToken()])
    setPinState(cfg.alwaysOnTop)
    hint.innerHTML = `Press <span class="kbd">${hotkey.replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')}</span> anywhere to summon me`
    if (!authed) {
      renderLogin()
      return
    }
    await refreshBots()
    await refreshApprovals()
    input.focus()
  })()

  return () => {
    disposers.forEach((d) => d())
  }
}
