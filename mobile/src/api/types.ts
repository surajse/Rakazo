/** Shared TypeScript types for the Rakazo backend API contract. */

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at?: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
}

export type BotStatus = 'idle' | 'running' | 'waiting_approval' | 'error' | string;

export interface Bot {
  id: string;
  name: string;
  template: string | null;
  status: BotStatus;
  last_activity_at: string | null;
  model?: string | null;
  routines?: string | null;
  created_at: string;
}

export interface BotTemplate {
  id: string;
  name: string;
  description: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  configured: boolean;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ApiToolCall {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status?: 'running' | 'done' | 'error';
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  tool_calls?: ApiToolCall[];
}

export interface MessagePage {
  messages: ChatMessage[];
  /** Cursor for the next (older) page; null/undefined when exhausted. */
  next_before?: string | null;
}

export interface RunStarted {
  run_id: string;
  message: ChatMessage;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | string;

export interface Approval {
  id: string;
  bot_id: string;
  bot_name?: string;
  kind: string;
  description: string;
  action?: string; // legacy alias
  status: ApprovalStatus;
  created_at: string;
  payload?: unknown;
}

export interface MemoryNote {
  key: string;
  value: string;
  updated_at: string;
}

export interface ThreadInfo {
  id: string;
  bot_id: string;
}

/** Events streamed by GET /api/bots/{id}/thread/messages/stream?run_id= */
export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; id: string; output?: unknown }
  | { type: 'approval_request'; id: string; description: string; action?: string }
  | { type: 'done'; message?: ChatMessage }
  | { type: 'error'; message: string };
