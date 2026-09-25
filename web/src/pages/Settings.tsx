import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../api/client';
import type { ApiError, ModelProvider, ModelProviderKind, Sandbox, SandboxKind, User } from '../api/types';
import { Alert, Badge, EmptyState, Field, Modal, PageHeader, Spinner, ToggleSwitch } from '../components/ui';
import { useAuth } from '../store/auth';
import { MODEL_PRESETS } from '../lib/utils';

function ProviderForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: ModelProvider;
  onSaved: (p: ModelProvider) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<ModelProviderKind>(initial?.kind ?? 'openai_compatible');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? 'https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(initial?.model ?? 'gpt-4o');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (presetId: string) => {
    const p = MODEL_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setName((v) => v || p.name);
    setKind(p.kind as ModelProviderKind);
    setBaseUrl(p.base_url);
    setDefaultModel(p.model);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name || kind,
        kind,
        base_url: baseUrl || undefined,
        model: defaultModel,
      };
      if (apiKey) body.api_key = apiKey;
      const saved = initial
        ? await patch<ModelProvider>(`/api/model-providers/${initial.id}`, body)
        : await post<ModelProvider>('/api/model-providers', body);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {!initial && (
        <div className="flex flex-wrap gap-2">
          {MODEL_PRESETS.map((p) => (
            <button key={p.id} type="button" className="btn-secondary !py-1.5 text-xs" onClick={() => applyPreset(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My OpenAI key" />
        </Field>
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ModelProviderKind)}>
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input className="input font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="Default model">
          <input className="input font-mono" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
        </Field>
      </div>
      <Field
        label={initial ? 'API key (leave blank to keep current)' : 'API key'}
        hint="Stored on your server. The API only ever shows a masked value."
      >
        <input className="input font-mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={initial ? '••••••••' : kind === 'ollama' ? 'Not needed for Ollama' : 'sk-…'} />
      </Field>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary" onClick={save} disabled={busy || !defaultModel}>
          {busy && <Spinner size={14} className="text-white" />} {initial ? 'Save' : 'Add provider'}
        </button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { user, logout } = useAuth();
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [sandboxKinds, setSandboxKinds] = useState<SandboxKind[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [providerModal, setProviderModal] = useState<{ open: boolean; edit?: ModelProvider }>({ open: false });
  const [sandboxName, setSandboxName] = useState('');
  const [sandboxKind, setSandboxKind] = useState('local_docker');
  const [sandboxBusy, setSandboxBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, s, k] = await Promise.all([
        get<ModelProvider[]>('/api/model-providers'),
        get<Sandbox[]>('/api/sandboxes'),
        get<SandboxKind[]>('/api/sandbox-kinds'),
      ]);
      setProviders(p);
      setSandboxes(s);
      setSandboxKinds(k.length > 0 ? k : [{ kind: 'local_docker', name: 'Local Docker' }]);
      setSandboxKind((k[0]?.kind ?? 'local_docker'));
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 0 ? 'Cannot reach the Rakazo API.' : err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const deleteProvider = async (p: ModelProvider) => {
    if (!confirm(`Delete provider "${p.name}"? Bots using it will need a new one.`)) return;
    try {
      await del(`/api/model-providers/${p.id}`);
      setProviders((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const toggleShare = async (s: Sandbox, shared: boolean) => {
    try {
      const updated = await patch<Sandbox>(`/api/sandboxes/${s.id}`, { shared });
      setSandboxes((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not update sharing');
    }
  };

  const addSandbox = async () => {
    setSandboxBusy(true);
    setError(null);
    try {
      const created = await post<Sandbox>('/api/sandboxes', {
        name: sandboxName || sandboxKind,
        kind: sandboxKind,
      });
      setSandboxes((prev) => [...prev, created]);
      setSandboxName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add sandbox');
    } finally {
      setSandboxBusy(false);
    }
  };

  const deleteSandbox = async (s: Sandbox) => {
    if (!confirm(`Delete sandbox "${s.name}"? Bots using it will need a new one.`)) return;
    try {
      await del(`/api/sandboxes/${s.id}`);
      setSandboxes((prev) => prev.filter((x) => x.id !== s.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" subtitle="Models, sandboxes, and your account." />

      {error && (
        <div className="mb-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size={28} />
        </div>
      ) : (
        <div className="space-y-8">
          {/* Providers */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Model providers</h2>
              <button className="btn-secondary !py-2 text-xs" onClick={() => setProviderModal({ open: true })}>
                + Add provider
              </button>
            </div>
            {providers.length === 0 ? (
              <EmptyState
                title="No model providers"
                body="Connect OpenAI, Anthropic, Ollama, Groq, or any OpenAI-compatible API. Your keys stay on your machine."
                action={<button className="btn-primary" onClick={() => setProviderModal({ open: true })}>Connect a provider</button>}
              />
            ) : (
              <div className="card divide-y divide-line">
                {providers.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{p.name}</p>
                      <p className="mt-0.5 font-mono text-xs text-muted">
                        {p.model} · key: {p.has_api_key ? p.api_key_masked ?? '••••' : '—'}
                      </p>
                    </div>
                    <Badge tone="gray">{p.kind}</Badge>
                    <button className="btn-ghost text-xs" onClick={() => setProviderModal({ open: true, edit: p })}>
                      Edit
                    </button>
                    <button className="btn-ghost !text-red-600 text-xs" onClick={() => deleteProvider(p)}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Sandboxes */}
          <section>
            <h2 className="mb-3 font-display text-lg font-semibold">Sandboxes</h2>
            {sandboxes.length === 0 ? (
              <EmptyState
                title="No sandboxes"
                body="A sandbox is the live computer your bot works in — running commands, browsing, and editing files."
              />
            ) : (
              <div className="card divide-y divide-line">
                {sandboxes.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{s.name}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {sandboxKinds.find((k) => k.kind === s.kind)?.description ?? s.kind}
                      </p>
                    </div>
                    <Badge tone="gray">{s.kind}</Badge>
                    {s.is_owner ? (
                      <>
                        <ToggleSwitch
                          checked={s.shared}
                          onChange={(next) => toggleShare(s, next)}
                          label="Shared with team"
                        />
                        <button className="btn-ghost !text-red-600 text-xs" onClick={() => deleteSandbox(s)}>
                          Delete
                        </button>
                      </>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Badge tone="blue">Shared</Badge>
                        <span className="text-xs text-muted">
                          by {s.owner_name || s.owner_email || 'another user'}
                        </span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="card mt-4 p-4">
              <div className="flex flex-wrap gap-2">
                <input
                  className="input !w-auto min-w-[180px] flex-1"
                  placeholder="Sandbox name"
                  value={sandboxName}
                  onChange={(e) => setSandboxName(e.target.value)}
                />
                <select className="input !w-auto" value={sandboxKind} onChange={(e) => setSandboxKind(e.target.value)}>
                  {sandboxKinds.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.name}
                    </option>
                  ))}
                </select>
                <button className="btn-primary" onClick={addSandbox} disabled={sandboxBusy}>
                  {sandboxBusy && <Spinner size={14} className="text-white" />} Add sandbox
                </button>
              </div>
            </div>
          </section>

          {/* Account */}
          <section>
            <h2 className="mb-3 font-display text-lg font-semibold">Account</h2>
            <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <p className="font-medium">{(user as User | null)?.name}</p>
                <p className="text-sm text-muted">{(user as User | null)?.email}</p>
              </div>
              <button className="btn-secondary" onClick={logout}>
                Sign out
              </button>
            </div>
          </section>
        </div>
      )}

      <Modal
        open={providerModal.open}
        onClose={() => setProviderModal({ open: false })}
        title={providerModal.edit ? 'Edit provider' : 'Add model provider'}
        wide
      >
        <ProviderForm
          initial={providerModal.edit}
          onCancel={() => setProviderModal({ open: false })}
          onSaved={(p) => {
            setProviders((prev) => {
              const i = prev.findIndex((x) => x.id === p.id);
              if (i >= 0) {
                const next = [...prev];
                next[i] = p;
                return next;
              }
              return [...prev, p];
            });
            setProviderModal({ open: false });
          }}
        />
      </Modal>
    </div>
  );
}
