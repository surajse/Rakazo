import type { ApiError, AuthTokens } from './types';

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  'http://localhost:8000';

const ACCESS_KEY = 'rakazo_access_token';
const REFRESH_KEY = 'rakazo_refresh_token';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(tokens: AuthTokens): void {
  localStorage.setItem(ACCESS_KEY, tokens.access_token);
  localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function apiError(status: number, message: string, body?: unknown): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.body = body;
  return err;
}

let refreshInFlight: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return null;
      try {
        const res = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) return null;
        const tokens = (await res.json()) as AuthTokens;
        setTokens(tokens);
        return tokens.access_token;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false for the refresh endpoint itself to avoid loops. */
  auth?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, auth = true } = opts;

  const doFetch = async (token: string | null): Promise<Response> => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined && !(body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
    }
    if (auth && token) {
      h['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${API_URL}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  };

  let res: Response;
  try {
    res = await doFetch(getAccessToken());
  } catch (e) {
    throw apiError(0, 'Could not reach the Rakazo API. Is the backend running?');
  }

  // Attempt a single token refresh on 401, then retry.
  if (res.status === 401 && auth) {
    const newToken = await tryRefresh();
    if (newToken) {
      res = await doFetch(newToken);
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let parsed: unknown = undefined;
    try {
      parsed = await res.json();
      const detail = (parsed as { detail?: unknown; message?: unknown }).detail ??
        (parsed as { message?: unknown }).message;
      if (typeof detail === 'string') message = detail;
      else if (detail != null) message = JSON.stringify(detail);
    } catch {
      try {
        const text = await res.text();
        if (text) message = text;
      } catch {
        /* ignore */
      }
    }
    throw apiError(res.status, message, parsed);
  }

  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/* ---------------------------------- SSE ---------------------------------- */

export type SseEventName =
  | 'token'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'done'
  | 'error';

export interface SseEvent {
  event: SseEventName;
  data: unknown;
}

export interface StreamHandle {
  close: () => void;
  closed: () => boolean;
}

/**
 * Fetch-based SSE reader (EventSource cannot send an Authorization header).
 * Calls onEvent for each parsed event; onDone when the stream ends cleanly.
 */
export async function streamEvents(
  path: string,
  onEvent: (ev: SseEvent) => void,
  opts: { signal?: AbortSignal; onDone?: () => void; onError?: (err: Error) => void } = {},
): Promise<StreamHandle> {
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;
  let isClosed = false;
  const close = () => {
    isClosed = true;
    controller.abort();
  };

  (async () => {
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, { headers, signal });
    } catch (e) {
      if (!isClosed) opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (!res.ok || !res.body) {
      opts.onError?.(apiError(res.status, `Stream failed (${res.status})`));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName: SseEventName | '' = '';
    let dataLines: string[] = [];

    const dispatch = () => {
      if (!eventName && dataLines.length === 0) return;
      const dataText = dataLines.join('\n');
      let data: unknown = dataText;
      try {
        data = dataText ? JSON.parse(dataText) : null;
      } catch {
        /* keep raw text */
      }
      const ev: SseEvent = { event: (eventName || 'message') as SseEventName, data };
      eventName = '';
      dataLines = [];
      onEvent(ev);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line === '') {
            dispatch();
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() as SseEventName;
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          } else if (line.startsWith(':')) {
            /* heartbeat comment */
          }
        }
      }
      dispatch();
      opts.onDone?.();
    } catch (e) {
      if (!isClosed) opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      isClosed = true;
      reader.releaseLock();
    }
  })();

  return { close, closed: () => isClosed };
}

/* --------------------------------- health --------------------------------- */

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
