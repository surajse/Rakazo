import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from '../api/client';
import type { ApiError, Bot, MemoryNote, ModelProvider, Sandbox } from '../api/types';
import { Alert, Badge, EmptyState, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { cx, formatDateTime } from '../lib/utils';

const TABS = ['General', 'Model & sandbox', 'Memory', 'Danger'] as const;

export function BotSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof TABS)[number]>('General');
  const [bot, setBot] = useState<Bot | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [memory, setMemory] = useState<MemoryNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  // form state
  const [name, setName] = useState('');
  const [status, setStatus] = useState<Bot['status']>('active');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [routinesMd, setRoutinesMd] = useState('');
  const [providerId, setProviderId] = useState('');
  const [sandboxId, setSandboxId] = useState('');

  // memory editor
  const [memKey, setMemKey] = useState('');
  const [memValue, setMemValue] = useState('');
  const [memBusy, setMemBusy] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [b, p, s, m] = await Promise.all([
        get<Bot>(`/api/bots/${id}`),
        get<ModelProvider[]>('/api/model-providers'),
        get<Sandbox[]>('/api/sandboxes'),
        get<MemoryNote[]>(`/api/bots/${id}/memory`),
      ]);
      setBot(b);
      setProviders(p);
      setSandboxes(s);
      setMemory(m);
      setName(b.name);
      setStatus(b.status);
      setSystemPrompt(b.system_prompt ?? '');
      setRoutinesMd(b.routines_md ?? '');
      setProviderId(b.model_provider_id ?? '');
      setSandboxId(b.sandbox_id ?? '');
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 0 ? 'Cannot reach the Rakazo API.' : err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const save = async () => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await patch<Bot>(`/api/bots/${id}`, {
        name: name.trim(),
        status,
        system_prompt: systemPrompt || null,
        routines_md: routinesMd || null,
        model_provider_id: providerId || null,
        sandbox_id: sandboxId || null,
      });
      setBot(updated);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addMemory = async () => {
    if (!id || !memKey.trim()) return;
    setMemBusy(true);
    try {
      const note = await post<MemoryNote>(`/api/bots/${id}/memory`, {
        key: memKey.trim(),
        value: memValue.trim(),
      });
      setMemory((prev) => {
        const i = prev.findIndex((n) => n.key === note.key);
        if (i >= 0) {
          const next = [...prev];
          next[i] = note;
          return next;
        }
        return [...prev, note];
      });
      setMemKey('');
      setMemValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save memory');
    } finally {
      setMemBusy(false);
    }
  };

  const deleteMemory = async (note: MemoryNote) => {
    if (!id) return;
    try {
      await del(`/api/bots/${id}/memory/${note.id}`);
      setMemory((prev) => prev.filter((n) => n.id !== note.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete memory');
    }
  };

  const remove = async () => {
    if (!id) return;
    try {
      await del(`/api/bots/${id}`);
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }

  if (error && !bot) {
    return (
      <EmptyState
        title="Could not load settings"
        body={error}
        action={
          <Link to="/" className="btn-secondary">
            Back to bots
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={`${bot?.name ?? 'Bot'} settings`}
        subtitle="Tune how this bot thinks, remembers, and works."
        action={
          <Link to={`/bots/${id}`} className="btn-secondary">
            Open thread
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}

      <div className="mb-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              'px-4 py-2.5 text-sm font-medium transition',
              tab === t
                ? 'border-b-2 border-primary text-primary-dark'
                : 'text-muted hover:text-ink',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'General' && (
        <div className="card space-y-5 p-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Status">
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Bot['status'])}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
          </div>
          <Field label="System prompt" hint="Core instructions that define this bot's role and tone.">
            <textarea className="input min-h-[140px] leading-6" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="You are a careful, proactive assistant…" />
          </Field>
          <Field label="Routines (Markdown)" hint="Standing routines in plain Markdown, checked every turn.">
            <textarea className="input min-h-[200px] font-mono text-[13px] leading-6" value={routinesMd} onChange={(e) => setRoutinesMd(e.target.value)} />
          </Field>
          <SaveBar saving={saving} saved={savedTick} onSave={save} />
        </div>
      )}

      {tab === 'Model & sandbox' && (
        <div className="card space-y-5 p-6">
          <Field label="Model provider" hint="Which model this bot thinks with.">
            <select className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">— None —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.model})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sandbox" hint="Where this bot runs commands and works with files.">
            <select className="input" value={sandboxId} onChange={(e) => setSandboxId(e.target.value)}>
              <option value="">— None —</option>
              {sandboxes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.kind})
                </option>
              ))}
            </select>
          </Field>
          <p className="text-sm text-muted">
            Manage providers and sandboxes in{' '}
            <Link to="/settings" className="link">
              Settings
            </Link>
            .
          </p>
          <SaveBar saving={saving} saved={savedTick} onSave={save} />
        </div>
      )}

      {tab === 'Memory' && (
        <div className="space-y-4">
          <div className="card p-6">
            <h3 className="font-display text-base font-semibold">Add a memory</h3>
            <p className="mt-1 text-sm text-muted">
              Notes the bot keeps about you, your preferences, and ongoing work.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_2fr]">
              <Field label="Key">
                <input className="input font-mono text-[13px]" value={memKey} onChange={(e) => setMemKey(e.target.value)} placeholder="user.timezone" />
              </Field>
              <Field label="Value">
                <input className="input" value={memValue} onChange={(e) => setMemValue(e.target.value)} placeholder="Asia/Kolkata" />
              </Field>
            </div>
            <button className="btn-primary mt-4" onClick={addMemory} disabled={memBusy || !memKey.trim()}>
              {memBusy && <Spinner size={14} className="text-white" />} Save memory
            </button>
          </div>

          {memory.length === 0 ? (
            <EmptyState
              title="No memories yet"
              body="The bot will store important facts here as you work together — or you can add them yourself."
            />
          ) : (
            <div className="card divide-y divide-line">
              {memory.map((n) => (
                <div key={n.id} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="font-mono text-[13px] font-semibold">{n.key}</p>
                    <p className="mt-1 break-words text-sm text-ink">{n.value}</p>
                    {n.updated_at && <p className="mt-1 text-xs text-muted">{formatDateTime(n.updated_at)}</p>}
                  </div>
                  <button className="btn-ghost !text-red-600 text-xs shrink-0" onClick={() => deleteMemory(n)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'Danger' && (
        <div className="card border-red-200 p-6">
          <h3 className="font-display text-base font-semibold text-red-700">Danger zone</h3>
          <p className="mt-1 text-sm text-muted">
            Deleting this bot removes its thread, memories, and sub-bots. This cannot be undone.
          </p>
          <button className="btn-danger mt-4" onClick={() => setConfirmDelete(true)}>
            Delete this bot
          </button>
        </div>
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete bot">
        <p className="text-sm text-ink">
          Delete <strong>{bot?.name}</strong>? Its thread, memory, and sub-bots will be removed.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={remove}>
            Delete bot
          </button>
        </div>
      </Modal>
    </div>
  );
}

function SaveBar({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
      {saved && <Badge tone="green">Saved</Badge>}
      <button className="btn-primary" onClick={onSave} disabled={saving}>
        {saving && <Spinner size={14} className="text-white" />} Save changes
      </button>
    </div>
  );
}
