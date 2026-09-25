import { ipcMain, shell } from 'electron'
import type { StreamEvent } from '../shared/types'
import { getConfig, setConfig, saveToken, loadToken, clearToken, applyAutoLaunch } from './store'
import { login, getBots, getThread, sendMessage, getApprovals, decideApproval, streamRun, probeWeb } from './api'
import { getQuickWindow, openMainWindow, openSettingsWindow, toggleQuickChat } from './windows'
import { HOTKEY } from './hotkey'
import { notifyRunFinished } from './notifier'

let streamAbort: AbortController | null = null

function stopStream(): void {
  streamAbort?.abort()
  streamAbort = null
}

export function setupIpc(): void {
  // ---- config ----
  ipcMain.handle('rakazo:get-config', () => getConfig())
  ipcMain.handle('rakazo:set-config', (_e, patch) => {
    const next = setConfig(patch)
    const q = getQuickWindow()
    if (q && typeof patch.alwaysOnTop === 'boolean') q.setAlwaysOnTop(patch.alwaysOnTop)
    return next
  })

  // ---- auth (token stays in main, in the OS keychain) ----
  ipcMain.handle('rakazo:login', async (_e, email: string, password: string) => {
    try {
      const token = await login(String(email), String(password))
      saveToken(token)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('rakazo:logout', () => clearToken())
  ipcMain.handle('rakazo:has-token', () => loadToken() !== null)
  ipcMain.handle('rakazo:test-connection', async () => {
    try {
      await getBots() // authenticated probe
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- bots / threads ----
  ipcMain.handle('rakazo:get-bots', () => getBots())
  ipcMain.handle('rakazo:get-thread', (_e, botId: string) => getThread(botId))
  ipcMain.handle('rakazo:send-message', (_e, botId: string, content: string) => sendMessage(botId, content))

  // ---- approvals ----
  ipcMain.handle('rakazo:get-approvals', () => getApprovals())
  ipcMain.handle('rakazo:decide-approval', (_e, id: string, decision: 'approve' | 'deny') =>
    decideApproval(id, decision)
  )

  // ---- SSE streaming ----
  ipcMain.handle('rakazo:stream-start', async (e, botId: string, botName: string, runId: string) => {
    stopStream()
    const abort = new AbortController()
    streamAbort = abort
    const sender = e.sender
    const emit = (evt: StreamEvent): void => {
      if (!sender.isDestroyed()) sender.send('rakazo:stream-event', evt)
    }
    try {
      await streamRun(botId, runId, emit, abort.signal)
      // Notify if the user wasn't watching the popup.
      const q = getQuickWindow()
      if (q && !q.isFocused()) notifyRunFinished(botName || 'Bot')
    } catch (err) {
      if (!abort.signal.aborted) {
        emit({ type: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      if (streamAbort === abort) streamAbort = null
    }
  })
  ipcMain.handle('rakazo:stream-stop', () => stopStream())

  // ---- windows ----
  ipcMain.on('rakazo:open-main', () => openMainWindow())
  ipcMain.on('rakazo:open-settings', () => openSettingsWindow())
  ipcMain.on('rakazo:toggle-quick', () => toggleQuickChat())
  ipcMain.handle('rakazo:set-always-on-top', (_e, v: boolean) => {
    setConfig({ alwaysOnTop: v })
    getQuickWindow()?.setAlwaysOnTop(v)
  })

  // ---- system ----
  ipcMain.handle('rakazo:set-auto-launch', (_e, v: boolean) => {
    const cfg = setConfig({ autoLaunch: v })
    applyAutoLaunch(v, cfg.startMinimized)
  })
  ipcMain.handle('rakazo:get-hotkey', () => HOTKEY)
  ipcMain.handle('rakazo:open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url)
    return Promise.reject(new Error('Refused to open non-http(s) URL'))
  })
  ipcMain.handle('rakazo:probe-web', (_e, url: string) => probeWeb(url))
}
