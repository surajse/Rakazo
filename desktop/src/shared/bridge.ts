import type { AppConfig, Approval, Bot, ChatMessage, StreamEvent } from './types'

/**
 * API exposed to renderer processes via the preload script (`window.rakazo`).
 * The auth token never leaves the main process — it is stored in the OS
 * keychain (Electron safeStorage) and attached to requests in main.
 */
export interface RakazoBridge {
  // config
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  // auth
  login(email: string, password: string): Promise<{ ok: boolean; error?: string }>
  logout(): Promise<void>
  hasToken(): Promise<boolean>
  testConnection(): Promise<{ ok: boolean; error?: string }>
  // bots / threads
  getBots(): Promise<Bot[]>
  getThread(botId: string): Promise<ChatMessage[]>
  sendMessage(botId: string, content: string): Promise<{ run_id: string }>
  // approvals
  getApprovals(): Promise<Approval[]>
  decideApproval(id: string, decision: 'approve' | 'deny'): Promise<void>
  // SSE streaming (runs in main so the Authorization header can be attached)
  streamStart(botId: string, botName: string, runId: string): Promise<void>
  streamStop(): Promise<void>
  onStreamEvent(cb: (e: StreamEvent) => void): () => void
  // deep link / notification navigation
  onOpenBot(cb: (botId: string) => void): () => void
  // windows
  openMain(): void
  openSettings(): void
  toggleQuickChat(): void
  setAlwaysOnTop(v: boolean): Promise<void>
  // system
  setAutoLaunch(v: boolean): Promise<void>
  getHotkey(): Promise<string>
  openExternal(url: string): Promise<void>
  /** Lightweight reachability check for an arbitrary URL (setup screen). */
  probeWeb(url: string): Promise<boolean>
}
