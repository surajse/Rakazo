import type { Approval, ApprovalsResponse, Bot, BotsResponse, ChatMessage, StreamEvent, ThreadResponse } from '../shared/types'
import { getConfig, loadToken } from './store'

function base(): string {
  return getConfig().apiUrl.replace(/\/+$/, '')
}

function authHeaders(token: string | null): Headers {
  const h = new Headers({ 'Content-Type': 'application/json' })
  if (token) h.set('Authorization', `Bearer ${token}`)
  return h
}

async function request<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const t = token === undefined ? loadToken() : token
  const res = await fetch(`${base()}${path}`, { ...init, headers: authHeaders(t) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status} ${path}: ${text || res.statusText}`)
  }
  if (res.status === 204) return null as T
  const ct = res.headers.get('content-type') ?? ''
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>
}

export async function login(email: string, password: string): Promise<string> {
  const res = await request<{ access_token: string; refresh_token: string }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    null
  )
  if (!res?.access_token) throw new Error('Login response did not include a token.')
  return res.access_token
}

export async function getBots(): Promise<Bot[]> {
  const res = await request<Bot[] | BotsResponse>('/api/bots')
  return Array.isArray(res) ? res : res.bots ?? []
}

export async function getThread(botId: string): Promise<ChatMessage[]> {
  const res = await request<ThreadResponse>(`/api/bots/${encodeURIComponent(botId)}/thread`)
  return res.messages ?? []
}

export async function sendMessage(botId: string, content: string): Promise<string> {
  const res = await request<{ run_id: string }>(`/api/bots/${encodeURIComponent(botId)}/thread/messages`, {
    method: 'POST',
    body: JSON.stringify({ content })
  })
  if (!res?.run_id) throw new Error('Send response did not include a run_id.')
  return res.run_id
}

export async function getApprovals(): Promise<Approval[]> {
  const res = await request<Approval[] | ApprovalsResponse>('/api/approvals?status=pending')
  return Array.isArray(res) ? res : res.approvals ?? []
}

export async function decideApproval(id: string, decision: 'approve' | 'deny'): Promise<void> {
  await request(`/api/approvals/${encodeURIComponent(id)}/${decision}`, { method: 'POST' })
}

/** Reachability probe for the web app URL (used by the setup screen). */
export async function probeWeb(url: string, timeoutMs = 4000): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/**
 * Stream a run's SSE events. Runs in main so the Authorization header can
 * be attached (browser EventSource cannot set headers). The backend may send
 * either `data: <raw text>` or `data: {"delta": "..."}` — both are handled.
 */
export async function streamRun(
  botId: string,
  runId: string,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const token = loadToken()
  const url = `${base()}/api/bots/${encodeURIComponent(botId)}/thread/messages/stream?run_id=${encodeURIComponent(runId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token ?? ''}`, Accept: 'text/event-stream' },
    signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Stream failed (${res.status}): ${text || res.statusText}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let doneEmitted = false
  const emitDone = (): void => {
    if (doneEmitted) return
    doneEmitted = true
    onEvent({ type: 'done' })
  }
  const emit = (payload: string): void => {
    if (payload === '[DONE]') {
      emitDone()
      return
    }
    try {
      const obj = JSON.parse(payload)
      const text = obj.delta ?? obj.text ?? obj.content ?? obj.token ?? ''
      if (typeof text === 'string' && text) onEvent({ type: 'delta', text })
      else if (obj.done === true) emitDone()
      else if (typeof obj.message === 'string' && obj.message) onEvent({ type: 'error', text: obj.message })
    } catch {
      onEvent({ type: 'delta', text: payload })
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) emit(line.slice(5).trim())
        // ignore `event:`, `:ping`, `id:` lines
      }
    }
  }
  emitDone()
}
