import { contextBridge, ipcRenderer } from 'electron'
import type { RakazoBridge } from '../shared/bridge'

// Context-isolated bridge: renderer gets a typed, minimal API surface.
// The auth token never crosses this boundary — it lives in the OS keychain
// in the main process.
const rakazo: RakazoBridge = {
  getConfig: () => ipcRenderer.invoke('rakazo:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('rakazo:set-config', patch),

  login: (email, password) => ipcRenderer.invoke('rakazo:login', email, password),
  logout: () => ipcRenderer.invoke('rakazo:logout'),
  hasToken: () => ipcRenderer.invoke('rakazo:has-token'),
  testConnection: () => ipcRenderer.invoke('rakazo:test-connection'),

  getBots: () => ipcRenderer.invoke('rakazo:get-bots'),
  getThread: (botId) => ipcRenderer.invoke('rakazo:get-thread', botId),
  sendMessage: (botId, content) => ipcRenderer.invoke('rakazo:send-message', botId, content),

  getApprovals: () => ipcRenderer.invoke('rakazo:get-approvals'),
  decideApproval: (id, decision) => ipcRenderer.invoke('rakazo:decide-approval', id, decision),

  streamStart: (botId, botName, runId) => ipcRenderer.invoke('rakazo:stream-start', botId, botName, runId),
  streamStop: () => ipcRenderer.invoke('rakazo:stream-stop'),
  onStreamEvent: (cb) => {
    const h = (_e: unknown, evt: Parameters<Parameters<RakazoBridge['onStreamEvent']>[0]>[0]) => cb(evt)
    ipcRenderer.on('rakazo:stream-event', h)
    return () => {
      ipcRenderer.removeListener('rakazo:stream-event', h)
    }
  },

  onOpenBot: (cb) => {
    const h = (_e: unknown, botId: string) => cb(botId)
    ipcRenderer.on('rakazo:open-bot', h)
    return () => {
      ipcRenderer.removeListener('rakazo:open-bot', h)
    }
  },

  openMain: () => ipcRenderer.send('rakazo:open-main'),
  openSettings: () => ipcRenderer.send('rakazo:open-settings'),
  toggleQuickChat: () => ipcRenderer.send('rakazo:toggle-quick'),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('rakazo:set-always-on-top', v),

  setAutoLaunch: (v) => ipcRenderer.invoke('rakazo:set-auto-launch', v),
  getHotkey: () => ipcRenderer.invoke('rakazo:get-hotkey'),
  openExternal: (url) => ipcRenderer.invoke('rakazo:open-external', url),
  probeWeb: (url) => ipcRenderer.invoke('rakazo:probe-web', url)
}

contextBridge.exposeInMainWorld('rakazo', rakazo)
