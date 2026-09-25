// Shared backend API contract types (mirrors the Rakazo backend).
// Web app and desktop app both speak this contract.

export interface Bot {
  id: string
  name: string
  description?: string
  model?: string
  created_at?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
  run_id?: string
}

export interface Approval {
  id: string
  bot_id: string
  bot_name?: string
  title?: string
  kind?: string
  detail?: string
  description?: string
  status: string
  created_at: string
}

export interface BotsResponse {
  bots: Bot[]
}

export interface ThreadResponse {
  messages: ChatMessage[]
}

export interface ApprovalsResponse {
  approvals: Approval[]
}

export interface StreamEvent {
  type: 'delta' | 'done' | 'error'
  /** Incremental text for `delta`, error detail for `error`. */
  text?: string
}

export interface AppConfig {
  /** Base URL of the Rakazo API, e.g. http://localhost:8000 */
  apiUrl: string
  /** URL of the Rakazo web app, e.g. http://localhost:5173 */
  webUrl: string
  autoLaunch: boolean
  startMinimized: boolean
  alwaysOnTop: boolean
}
