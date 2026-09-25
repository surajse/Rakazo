import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, streamEvents, type SseEvent } from '../api/client';
import type { ApiError, Bot, ChatMessage, Thread, ToolCall } from '../api/types';
import { Badge, EmptyState, Spinner } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { cx, formatDateTime } from '../lib/utils';
import { useDictation, useSpeechOutput } from '../lib/useSpeech';

/* ------------------------------- tool call row ------------------------------- */

function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const tone: Record<string, 'gray' | 'blue' | 'green' | 'red' | 'amber'> = {
    running: 'blue',
    done: 'green',
    error: 'red',
    awaiting_approval: 'amber',
  };
  return (
    <div className="rounded-lg border border-line bg-gray-50/60">
      <button
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={cx('text-xs transition', open ? 'rotate-90' : '')}>▶</span>
        <span className="font-mono text-xs font-semibold text-ink">{tool.type}</span>
        <span className="truncate text-xs text-muted">{tool.label}</span>
        <span className="ml-auto shrink-0">
          <Badge tone={tone[tool.status ?? 'running'] ?? 'gray'}>{tool.status ?? 'running'}</Badge>
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          {tool.input && (
            <div>
              <p className="label !mb-1">Input</p>
              <pre className="overflow-x-auto rounded-md bg-gray-900 p-2.5 font-mono text-[11px] leading-5 text-gray-100">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div className="mt-2">
              <p className="label !mb-1">Output</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-gray-900 p-2.5 font-mono text-[11px] leading-5 text-gray-100">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ approval card ------------------------------ */

interface InlineApproval {
  id: string;
  kind?: string;
  action?: string;
  description?: string;
  payload?: Record<string, unknown> | null;
  status: 'pending' | 'approved' | 'denied';
}

function ApprovalCard({ approval }: { approval: InlineApproval }) {
  const [state, setState] = useState(approval.status);
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    try {
      await post(`/api/approvals/${approval.id}/${decision}`);
      setState(decision === 'approve' ? 'approved' : 'denied');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-center gap-2">
        <Badge tone="amber">Approval needed</Badge>
      </div>
      <p className="mt-2 text-sm font-medium">{approval.description ?? approval.action ?? approval.kind ?? 'Action requires approval'}</p>
      {approval.payload && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-white/70 p-2 font-mono text-[11px] text-ink">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      )}
      {state === 'pending' ? (
        <div className="mt-3 flex gap-2">
          <button className="btn-primary !py-1.5 text-xs" disabled={busy} onClick={() => decide('approve')}>
            Approve
          </button>
          <button className="btn-secondary !py-1.5 text-xs" disabled={busy} onClick={() => decide('deny')}>
            Deny
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs font-semibold text-muted">
          {state === 'approved' ? 'Approved — the bot may continue.' : 'Denied — the bot was stopped.'}
        </p>
      )}
    </div>
  );
}

/* --------------------------------- message --------------------------------- */

interface ChatBubbleProps {
  message: ChatMessage;
  speechSupported: boolean;
  speakingId: string | null;
  onSpeak: (id: string, text: string) => void;
  onStopSpeak: () => void;
}

function SpeakerToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? 'Stop reading aloud' : 'Read reply aloud'}
      aria-label={active ? 'Stop reading aloud' : 'Read reply aloud'}
      aria-pressed={active}
      className={cx(
        'rounded-full p-1.5 transition',
        active
          ? 'animate-pulse bg-primary-soft text-primary-dark'
          : 'text-muted hover:bg-gray-100 hover:text-ink',
      )}
    >
      {active ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      )}
    </button>
  );
}

function ChatBubble({ message, speechSupported, speakingId, onSpeak, onStopSpeak }: ChatBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-white">
          <Markdown text={message.content} className="[&_p]:my-1 [&_code]:!bg-white/20 [&_a]:!text-white" />
          <p className="mt-1 text-right text-[11px] text-white/70">{formatDateTime(message.created_at)}</p>
        </div>
      </div>
    );
  }
  const speaking = speakingId === message.id;
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3 shadow-soft">
        {message.content && <Markdown text={message.content} />}
        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className={cx('flex flex-col gap-2', message.content && 'mt-3')}>
            {message.tool_calls.map((t) => (
              <ToolRow key={t.id} tool={t} />
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted">{formatDateTime(message.created_at)}</p>
          {speechSupported && message.content && (
            <SpeakerToggle
              active={speaking}
              onToggle={() => (speaking ? onStopSpeak() : onSpeak(message.id, message.content))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- page --------------------------------- */

interface StreamItem {
  key: string;
  kind: 'approval';
  approval: InlineApproval;
}

export function BotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inline, setInline] = useState<StreamItem[]>([]); // approval cards etc.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamTools, setStreamTools] = useState<ToolCall[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const streamTextRef = useRef('');
  const streamToolsRef = useRef<ToolCall[]>([]);

  /* ------------------------------- voice mode -------------------------------- */

  const dictation = useDictation({
    onFinal: (text) =>
      setDraft((prev) => (prev.trimEnd() ? `${prev.trimEnd()} ${text}` : text)),
  });
  const speech = useSpeechOutput();

  useEffect(() => {
    streamTextRef.current = streamText;
  }, [streamText]);
  useEffect(() => {
    streamToolsRef.current = streamTools;
  }, [streamTools]);

  const scrollToBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (force || nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [streamText, streamTools, inline, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 160 && hasMore && !loadingMore && messages.length > 0) {
      loadOlder();
    }
  };

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [b, t] = await Promise.all([
        get<Bot>(`/api/bots/${id}`),
        get<{ thread: Thread; messages: ChatMessage[] }>(`/api/bots/${id}/thread`),
      ]);
      setBot(b);
      setThread(t.thread);
      setMessages(t.messages ?? []);
      setHasMore((t.messages ?? []).length >= 50);
      requestAnimationFrame(() => scrollToBottom(true));
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 0 ? 'Cannot reach the Rakazo API.' : err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadOlder = async () => {
    if (!id || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0].id;
      const older = await get<ChatMessage[]>(
        `/api/bots/${id}/thread/messages?before=${encodeURIComponent(oldest)}&limit=25`,
      );
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      setMessages((prev) => [...(older ?? []), ...prev]);
      setHasMore((older ?? []).length >= 25);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  /* ------------------------------- streaming ------------------------------- */

  const handleEvent = useCallback((ev: SseEvent) => {
    const d = ev.data as Record<string, unknown>;
    switch (ev.event) {
      case 'token': {
        const t = typeof d === 'string' ? d : String((d as { text?: string }).text ?? '');
        setStreamText((prev) => prev + t);
        break;
      }
      case 'tool_call': {
        const tool = d as unknown as ToolCall;
        setStreamTools((prev) => {
          const i = prev.findIndex((x) => x.id === tool.id);
          if (i >= 0) {
            const next = [...prev];
            next[i] = { ...next[i], ...tool };
            return next;
          }
          return [...prev, tool];
        });
        break;
      }
      case 'tool_result': {
        const tool = d as unknown as ToolCall;
        setStreamTools((prev) =>
          prev.map((x) => (x.id === tool.id ? { ...x, ...tool } : x)),
        );
        break;
      }
      case 'approval_request': {
        const a = d as { id: string; action?: string; kind?: string; description?: string; payload?: Record<string, unknown> };
        setInline((prev) => [
          ...prev,
          { key: `approval-${a.id}`, kind: 'approval', approval: { ...a, status: 'pending' } },
        ]);
        break;
      }
      case 'done': {
        const final = d as { content?: string; tool_calls?: ToolCall[] } | null;
        const finalText = final?.content ?? streamTextRef.current;
        const finalTools = final?.tool_calls ?? streamToolsRef.current;
        const rid = runIdRef.current;
        setMessages((prev) => [
          ...prev,
          {
            id: `run-${rid ?? Date.now()}`,
            role: 'assistant',
            content: finalText,
            tool_calls: finalTools,
            created_at: new Date().toISOString(),
            run_id: rid,
          },
        ]);
        setStreaming(false);
        runIdRef.current = null;
        setStreamText('');
        setStreamTools([]);
        break;
      }
      case 'error': {
        setStreamError(typeof d === 'string' ? d : String((d as { message?: string }).message ?? 'Stream error'));
        setStreaming(false);
        break;
      }
      default:
        break;
    }
  }, []);

  const send = async () => {
    const content = draft.trim();
    if (!content || streaming || !id) return;
    // Hand the mic and the speaker back: sending starts fresh.
    dictation.stop();
    speech.stop();
    setDraft('');
    setStreamError(null);
    setInline([]);

    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom(true);

    try {
      const { message, run_id } = await post<{ message: ChatMessage; run_id: string }>(
        `/api/bots/${id}/thread/messages`,
        { content },
      );
      // Replace optimistic message with server version if ids differ.
      if (message?.id && message.id !== userMsg.id) {
        setMessages((prev) => prev.map((m) => (m.id === userMsg.id ? message : m)));
      }

      runIdRef.current = run_id;
      setStreaming(true);
      setStreamText('');
      setStreamTools([]);

      const controller = new AbortController();
      abortRef.current = controller;
      await streamEvents(
        `/api/bots/${id}/thread/messages/stream?run_id=${encodeURIComponent(run_id)}`,
        handleEvent,
        {
          signal: controller.signal,
          onError: (err) => {
            if (err.name === 'AbortError') return;
            setStreamError(err.message || 'Stream disconnected.');
            setStreaming(false);
          },
        },
      );
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : 'Failed to send message');
      setStreaming(false);
    }
  };

  const stop = async () => {
    if (!id || !runIdRef.current) return;
    try {
      await post(`/api/bots/${id}/runs/${runIdRef.current}/cancel`);
    } catch (e) {
      console.error(e);
    } finally {
      abortRef.current?.abort();
      setStreaming(false);
      // Commit whatever streamed so far as a partial message.
      if (streamTextRef.current || streamToolsRef.current.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `run-${runIdRef.current}-stopped`,
            role: 'assistant',
            content: streamTextRef.current + '\n\n_Stopped by user._',
            tool_calls: streamToolsRef.current,
            created_at: new Date().toISOString(),
            run_id: runIdRef.current,
          },
        ]);
      }
      runIdRef.current = null;
      setStreamText('');
      setStreamTools([]);
    }
  };

  const streamingBubble = useMemo(() => {
    if (!streaming && !streamError) return null;
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3 shadow-soft">
          {streamText ? (
            <Markdown text={streamText} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Working…
            </p>
          )}
          {streamTools.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {streamTools.map((t) => (
                <ToolRow key={t.id} tool={t} />
              ))}
            </div>
          )}
          {streamError && <p className="mt-2 text-sm text-red-700">{streamError}</p>}
        </div>
      </div>
    );
  }, [streaming, streamText, streamTools, streamError]);

  /* --------------------------------- render --------------------------------- */

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }

  if (error || !bot) {
    return (
      <EmptyState
        title="Could not load bot"
        body={error ?? 'This bot does not exist.'}
        action={
          <div className="flex gap-2">
            <Link to="/" className="btn-secondary">
              Back to bots
            </Link>
            <button className="btn-primary" onClick={load}>
              Retry
            </button>
          </div>
        }
      />
    );
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight">{bot.name}</h1>
            <Badge tone={bot.status === 'active' ? 'green' : 'amber'}>{bot.status}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            One ongoing thread · {thread ? `started ${formatDateTime(thread.created_at)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/bots/${bot.id}/subbots`} className="btn-secondary !py-2 text-xs">
            Sub-bots
          </Link>
          <Link to={`/bots/${bot.id}/settings`} className="btn-secondary !py-2 text-xs">
            Settings
          </Link>
        </div>
      </div>

      {/* messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="card flex-1 space-y-4 overflow-y-auto p-4 sm:p-6"
      >
        {hasMore && messages.length > 0 && (
          <div className="flex justify-center">
            <button className="btn-ghost text-xs" onClick={loadOlder} disabled={loadingMore}>
              {loadingMore ? <Spinner size={14} /> : 'Load older messages'}
            </button>
          </div>
        )}
        {messages.length === 0 && !streaming && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <h3 className="font-display text-lg font-semibold">Start the conversation</h3>
            <p className="mt-2 max-w-md text-sm text-muted">
              {bot.name} keeps one ongoing thread. It remembers what matters, can use its sandbox
              to do real work, and will ask for approval before risky actions.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble
            key={m.id}
            message={m}
            speechSupported={speech.supported}
            speakingId={speech.speakingId}
            onSpeak={speech.speak}
            onStopSpeak={speech.stop}
          />
        ))}
        {inline.map((item) =>
          item.kind === 'approval' ? (
            <div key={item.key} className="flex justify-start">
              <div className="w-full max-w-[90%]">
                <ApprovalCard approval={item.approval} />
              </div>
            </div>
          ) : null,
        )}
        {streamingBubble}
      </div>

      {/* composer */}
      <div className="mt-4">
        {streamError && !streaming && (
          <p className="mb-2 text-sm text-red-700">{streamError}</p>
        )}
        {dictation.error && (
          <p className="mb-2 text-sm text-red-700">{dictation.error}</p>
        )}
        {dictation.listening && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
            </span>
            <span className="shrink-0 font-medium">Listening…</span>
            {dictation.interim && (
              <span className="truncate text-red-700/80">{dictation.interim}</span>
            )}
          </div>
        )}
        <div className="card flex items-end gap-2 p-3">
          <textarea
            className="input min-h-[44px] flex-1 resize-none border-0 !shadow-none focus:!ring-0"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Ask ${bot.name} to do something…`}
            disabled={streaming}
          />
          {dictation.supported && (
            <button
              type="button"
              onClick={dictation.toggle}
              disabled={streaming}
              title={dictation.listening ? 'Stop dictation' : 'Dictate with your voice'}
              aria-label={dictation.listening ? 'Stop dictation' : 'Dictate with your voice'}
              aria-pressed={dictation.listening}
              className={cx(
                'shrink-0 rounded-full p-2.5 transition disabled:opacity-40',
                dictation.listening
                  ? 'animate-pulse bg-red-100 text-red-700'
                  : 'text-muted hover:bg-gray-100 hover:text-ink',
              )}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>
          )}
          {streaming ? (
            <button className="btn-danger shrink-0" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn-primary shrink-0" onClick={send} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">
          The bot can run commands and edit files in its sandbox. Sensitive actions pause for your
          approval.
          {!dictation.supported &&
            ' Voice input is unavailable in this browser — try Chrome or Edge to dictate.'}
          {!speech.supported &&
            ' Read-aloud is unavailable in this browser.'}
        </p>
      </div>
    </div>
  );
}
