/**
 * Rakazo API client.
 *
 * - All requests go through `request()`, which attaches the Bearer access
 *   token and transparently refreshes it once on 401.
 * - `streamRun()` consumes the SSE run stream via `expo/fetch`, which
 *   supports streaming response bodies (RN's legacy fetch does not).
 *
 * The client is a singleton; wire storage hooks once via `configure()`
 * (done in the AuthProvider).
 */
import { fetch as expoFetch } from 'expo/fetch';
import type {
  Approval,
  Bot,
  BotTemplate,
  ChatMessage,
  MemoryNote,
  MessagePage,
  ModelProvider,
  RunStarted,
  StreamEvent,
  ThreadInfo,
  TokenPair,
  User,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class AuthError extends ApiError {
  constructor(message = 'Session expired. Please sign in again.') {
    super(401, message);
    this.name = 'AuthError';
  }
}

interface ClientHooks {
  getAccessToken: () => Promise<string | null>;
  getRefreshToken: () => Promise<string | null>;
  saveTokens: (tokens: TokenPair) => Promise<void>;
  clearTokens: () => Promise<void>;
  getBaseUrl: () => Promise<string>;
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
};

const DEFAULT_LIMIT = 30;

class RakazoClient {
  private hooks: ClientHooks | null = null;
  private refreshPromise: Promise<TokenPair> | null = null;

  configure(hooks: ClientHooks) {
    this.hooks = hooks;
  }

  private requireHooks(): ClientHooks {
    if (!this.hooks) throw new Error('RakazoClient not configured — call api.configure() first.');
    return this.hooks;
  }

  private async baseUrl(): Promise<string> {
    const raw = (await this.requireHooks().getBaseUrl()).trim();
    return raw.replace(/\/+$/, '');
  }

  /** Refresh the access token; concurrent callers share one in-flight request. */
  private async refreshTokens(): Promise<TokenPair> {
    const hooks = this.requireHooks();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const refreshToken = await hooks.getRefreshToken();
      if (!refreshToken) throw new AuthError();
      const res = await fetch(`${await this.baseUrl()}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        await hooks.clearTokens();
        throw new AuthError();
      }
      const tokens = (await res.json()) as TokenPair;
      await hooks.saveTokens(tokens);
      return tokens;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    const hooks = this.requireHooks();
    const useAuth = opts.auth !== false;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (useAuth) {
      const token = await hooks.getAccessToken();
      if (!token) throw new AuthError();
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${await this.baseUrl()}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (res.status === 401 && useAuth && !retried) {
      await this.refreshTokens();
      return this.request<T>(path, opts, true);
    }
    if (res.status === 401 && useAuth) {
      await hooks.clearTokens();
      throw new AuthError();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `Request failed (${res.status})`;
      try {
        const json = JSON.parse(text) as { detail?: string; message?: string };
        message = json.detail ?? json.message ?? message;
      } catch {
        if (text) message = text.slice(0, 200);
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------ auth
  async signup(email: string, password: string, name?: string): Promise<TokenPair> {
    return this.request<TokenPair>('/api/auth/signup', {
      method: 'POST',
      body: { email, password, ...(name ? { name } : {}) },
      auth: false,
    });
  }

  async login(email: string, password: string): Promise<TokenPair> {
    return this.request<TokenPair>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });
  }

  async me(): Promise<User> {
    return this.request<User>('/api/me');
  }

  // ------------------------------------------------------------------- bots
  async listBots(): Promise<Bot[]> {
    const data = await this.request<Bot[] | { bots: Bot[] }>('/api/bots');
    return Array.isArray(data) ? data : data.bots;
  }

  async getBot(id: string): Promise<Bot> {
    return this.request<Bot>(`/api/bots/${id}`);
  }

  async createBot(input: { name: string; template?: string }): Promise<Bot> {
    return this.request<Bot>('/api/bots', { method: 'POST', body: input });
  }

  /** Best-effort bot update (name / routines). Not all backends implement PATCH. */
  async updateBot(id: string, input: { name?: string; routines?: string }): Promise<Bot> {
    return this.request<Bot>(`/api/bots/${id}`, { method: 'PATCH', body: input });
  }

  async listTemplates(): Promise<BotTemplate[]> {
    const data = await this.request<BotTemplate[] | { templates: BotTemplate[] }>('/api/templates');
    return Array.isArray(data) ? data : data.templates;
  }

  /** Best-effort provider list; returns [] when the backend has no such endpoint. */
  async listProviders(): Promise<ModelProvider[]> {
    try {
      const data = await this.request<ModelProvider[] | { providers: ModelProvider[] }>('/api/model-providers');
      return Array.isArray(data) ? data : data.providers;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }

  // ------------------------------------------------------------------ thread
  async getThread(botId: string): Promise<ThreadInfo> {
    return this.request<ThreadInfo>(`/api/bots/${botId}/thread`);
  }

  async listMessages(botId: string, before?: string, limit = DEFAULT_LIMIT): Promise<MessagePage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    const data = await this.request<MessagePage | ChatMessage[]>(
      `/api/bots/${botId}/thread/messages?${params.toString()}`,
    );
    if (Array.isArray(data)) return { messages: data, next_before: null };
    return data;
  }

  async postMessage(botId: string, content: string): Promise<RunStarted> {
    return this.request<RunStarted>(`/api/bots/${botId}/thread/messages`, {
      method: 'POST',
      body: { content },
    });
  }

  async cancelRun(botId: string, runId: string): Promise<void> {
    await this.request<void>(`/api/bots/${botId}/runs/${runId}/cancel`, { method: 'POST' });
  }

  /**
   * Consume the SSE run stream. `onEvent` receives parsed events:
   * token / tool_call / tool_result / approval_request / done / error.
   * Pass an AbortSignal to stop the stream from the UI.
   */
  async streamRun(args: {
    botId: string;
    runId: string;
    onEvent: (event: StreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const hooks = this.requireHooks();
    const token = await hooks.getAccessToken();
    if (!token) throw new AuthError();
    const url = `${await this.baseUrl()}/api/bots/${args.botId}/thread/messages/stream?run_id=${encodeURIComponent(args.runId)}`;
    const res = await expoFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: args.signal,
    });
    if (res.status === 401) {
      await this.refreshTokens();
      const retryToken = await hooks.getAccessToken();
      if (!retryToken) throw new AuthError();
      return this.streamRun(args);
    }
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, `Stream failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const dispatch = (frame: string) => {
      const event = parseSseFrame(frame);
      if (event) args.onEvent(event);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          dispatch(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) dispatch(buffer);
    } finally {
      reader.releaseLock();
    }
  }

  // --------------------------------------------------------------- approvals
  async listApprovals(status: 'pending' | 'approved' | 'denied' | 'all' = 'pending'): Promise<Approval[]> {
    const data = await this.request<Approval[] | { approvals: Approval[] }>(
      `/api/approvals?status=${encodeURIComponent(status)}`,
    );
    return Array.isArray(data) ? data : data.approvals;
  }

  async approveApproval(id: string): Promise<Approval> {
    return this.request<Approval>(`/api/approvals/${id}/approve`, { method: 'POST' });
  }

  async denyApproval(id: string): Promise<Approval> {
    return this.request<Approval>(`/api/approvals/${id}/deny`, { method: 'POST' });
  }

  // ------------------------------------------------------------------ memory
  async listMemoryNotes(botId: string): Promise<MemoryNote[]> {
    const data = await this.request<MemoryNote[] | { notes: MemoryNote[] }>(`/api/bots/${botId}/memory`);
    return Array.isArray(data) ? data : data.notes;
  }

  async addMemoryNote(botId: string, key: string, value: string): Promise<MemoryNote> {
    return this.request<MemoryNote>(`/api/bots/${botId}/memory`, { method: 'POST', body: { key, value } });
  }

  async deleteMemoryNote(botId: string, key: string): Promise<void> {
    await this.request<void>(`/api/bots/${botId}/memory/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }
}

/** Parse one SSE frame into a StreamEvent. Tolerates `event:`+`data:` framing
 *  as well as data-only JSON payloads carrying a `type` field. */
function parseSseFrame(frame: string): StreamEvent | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith(':')) continue; // comment / heartbeat
  }
  const raw = dataLines.join('\n');
  if (!raw) return null;
  let data: unknown = raw;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    // plain-text payload (e.g. a raw token)
  }
  const obj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const type = (eventName || (obj.type as string) || '').toLowerCase();
  const text = typeof data === 'string' ? data : (obj.text as string) ?? (obj.delta as string) ?? (obj.content as string) ?? '';
  switch (type) {
    case 'token':
      return { type: 'token', text };
    case 'tool_call':
      return {
        type: 'tool_call',
        id: String(obj.id ?? obj.tool_call_id ?? ''),
        name: String(obj.name ?? obj.tool ?? 'tool'),
        input: obj.input ?? obj.arguments,
      };
    case 'tool_result':
      return { type: 'tool_result', id: String(obj.id ?? obj.tool_call_id ?? ''), output: obj.output ?? obj.result };
    case 'approval_request':
      return {
        type: 'approval_request',
        id: String(obj.id ?? ''),
        description: String(obj.description ?? obj.action ?? 'Approval requested'),
        action: typeof obj.action === 'string' ? obj.action : undefined,
      };
    case 'done':
      return { type: 'done', message: obj.message as ChatMessage | undefined };
    case 'error':
      return { type: 'error', message: String((obj.message as string) ?? (obj.error as string) ?? 'Stream error') };
    default:
      return null;
  }
}

export const api = new RakazoClient();
