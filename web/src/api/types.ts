export interface User {
  id: string;
  email: string;
  name: string;
  created_at?: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type?: string;
}

export type ModelProviderKind = 'openai_compatible' | 'anthropic' | 'ollama';

export interface ModelProvider {
  id: string;
  name: string;
  kind: ModelProviderKind;
  base_url?: string | null;
  api_key_masked?: string | null; // masked by server
  has_api_key?: boolean;
  model: string;
  created_at?: string;
}

export interface SandboxKind {
  kind: string;
  name: string;
  description?: string;
}

export interface Sandbox {
  id: string;
  name: string;
  kind: string;
  config?: Record<string, unknown> | null;
  created_at?: string;
}

export interface BotTemplate {
  id: string;
  name: string;
  description: string;
  icon?: string;
  default_system_prompt?: string;
  default_routines_md?: string;
}

export type BotStatus = 'active' | 'paused' | 'archived';

export interface Bot {
  id: string;
  name: string;
  template?: string | null;
  model_provider_id?: string | null;
  sandbox_id?: string | null;
  system_prompt?: string | null;
  routines_md?: string | null;
  parent_bot_id?: string | null;
  status: BotStatus;
  last_activity_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Thread {
  id: string;
  bot_id: string;
  created_at?: string;
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ToolCall {
  id: string;
  type: string; // e.g. "shell", "file_read", "file_write", "browser", "approval", "subbot"
  label: string;
  input?: Record<string, unknown> | null;
  output?: string | null;
  status?: 'running' | 'done' | 'error' | 'awaiting_approval';
  duration_ms?: number | null;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  created_at: string;
  run_id?: string | null;
}

export interface Approval {
  id: string;
  bot_id: string;
  bot_name?: string;
  run_id?: string | null;
  kind: string;
  description: string;
  action?: string; // legacy alias for description
  payload?: Record<string, unknown> | null;
  status: 'pending' | 'approved' | 'denied';
  reason?: string | null;
  created_at: string;
  resolved_at?: string | null;
  decided_at?: string | null;
}

export interface MemoryNote {
  id: string;
  key: string;
  value: string;
  updated_at?: string;
}

export interface AuditEntry {
  id: string;
  time: string;
  actor: string;
  bot_id?: string | null;
  bot_name?: string | null;
  action: string;
  details?: string | null;
}

// Raw shape returned by the backend (/api/audit)
export interface AuditRecord {
  id: string;
  event_type: string;
  user_id?: string | null;
  bot_id?: string | null;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

export function toAuditEntry(r: AuditRecord): AuditEntry {
  return {
    id: r.id,
    time: r.created_at,
    actor: r.user_id ?? 'system',
    bot_id: r.bot_id,
    action: r.event_type,
    details: r.detail ? JSON.stringify(r.detail) : null,
  };
}

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}
