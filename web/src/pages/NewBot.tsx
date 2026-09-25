import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../api/client';
import type { BotTemplate, ModelProvider, ModelProviderKind, Sandbox, SandboxKind } from '../api/types';
import { Alert, Badge, Field, PageHeader, Spinner } from '../components/ui';
import { cx, MODEL_PRESETS, TEMPLATE_FALLBACKS } from '../lib/utils';

interface WizardState {
  templateId: string | null;
  name: string;
  providerId: string | null;
  sandboxId: string | null;
  routinesMd: string;
}

function stepsBar(step: number) {
  const labels = ['Template', 'Model & sandbox', 'Routines'];
  return (
    <ol className="mb-8 flex items-center gap-2">
      {labels.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={cx(
              'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold',
              i < step
                ? 'bg-primary text-white'
                : i === step
                  ? 'bg-primary text-white'
                  : 'bg-gray-200 text-muted',
            )}
          >
            {i + 1}
          </span>
          <span className={cx('text-sm font-medium', i === step ? 'text-ink' : 'text-muted')}>
            {label}
          </span>
          {i < labels.length - 1 && <span className="mx-2 h-px w-8 bg-line" />}
        </li>
      ))}
    </ol>
  );
}

export function NewBotPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<BotTemplate[]>(TEMPLATE_FALLBACKS as BotTemplate[]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [sandboxKinds, setSandboxKinds] = useState<SandboxKind[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [w, setW] = useState<WizardState>({
    templateId: null,
    name: '',
    providerId: null,
    sandboxId: null,
    routinesMd: '',
  });

  // Inline "new provider" form
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [pf, setPf] = useState({
    name: '',
    kind: 'openai_compatible' as ModelProviderKind,
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o',
  });
  const [savingProvider, setSavingProvider] = useState(false);

  // Inline "new sandbox" form
  const [showSandboxForm, setShowSandboxForm] = useState(false);
  const [sf, setSf] = useState({ name: '', kind: 'local_docker' });
  const [savingSandbox, setSavingSandbox] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [t, p, s, k] = await Promise.allSettled([
          get<BotTemplate[]>('/api/templates'),
          get<ModelProvider[]>('/api/model-providers'),
          get<Sandbox[]>('/api/sandboxes'),
          get<SandboxKind[]>('/api/sandbox-kinds'),
        ]);
        if (t.status === 'fulfilled' && t.value.length > 0) setTemplates(t.value);
        if (p.status === 'fulfilled') setProviders(p.value);
        if (s.status === 'fulfilled') setSandboxes(s.value);
        if (k.status === 'fulfilled' && k.value.length > 0) {
          setSandboxKinds(k.value);
          setSf((prev) => ({ ...prev, kind: k.value[0].kind }));
        } else {
          setSandboxKinds([{ kind: 'local_docker', name: 'Local Docker', description: 'Runs in a Docker container on this machine.' }]);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const pickTemplate = (t: BotTemplate | null) => {
    setW((prev) => ({
      ...prev,
      templateId: t?.id ?? null,
      name: prev.name || t?.name || '',
      routinesMd: t?.default_routines_md ?? prev.routinesMd,
    }));
    setStep(1);
  };

  const applyPreset = (presetId: string) => {
    const p = MODEL_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setPf({
      name: p.name,
      kind: p.kind as ModelProviderKind,
      base_url: p.base_url,
      api_key: '',
      model: p.model,
    });
  };

  const saveProvider = async () => {
    setSavingProvider(true);
    setError(null);
    try {
      const created = await post<ModelProvider>('/api/model-providers', {
        name: pf.name || pf.kind,
        kind: pf.kind,
        base_url: pf.base_url || undefined,
        api_key: pf.api_key || undefined,
        model: pf.model,
      });
      setProviders((prev) => [...prev, created]);
      setW((prev) => ({ ...prev, providerId: created.id }));
      setShowProviderForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save provider');
    } finally {
      setSavingProvider(false);
    }
  };

  const saveSandbox = async () => {
    setSavingSandbox(true);
    setError(null);
    try {
      const created = await post<Sandbox>('/api/sandboxes', {
        name: sf.name || sf.kind,
        kind: sf.kind,
      });
      setSandboxes((prev) => [...prev, created]);
      setW((prev) => ({ ...prev, sandboxId: created.id }));
      setShowSandboxForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save sandbox');
    } finally {
      setSavingSandbox(false);
    }
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const bot = await post<{ id: string }>('/api/bots', {
        name: w.name.trim(),
        template: w.templateId,
        model_provider_id: w.providerId,
        sandbox_id: w.sandboxId,
        routines_md: w.routinesMd || undefined,
        system_prompt: undefined,
      });
      navigate(`/bots/${bot.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create bot');
      setCreating(false);
    }
  };

  const canContinueStep1 = w.name.trim().length > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New bot" subtitle="Pick a template, connect a model, and give it a sandbox." />
      {stepsBar(step)}
      {error && (
        <div className="mb-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner size={28} />
        </div>
      )}

      {!loading && step === 0 && (
        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => pickTemplate(t)}
                className={cx(
                  'card p-5 text-left transition hover:shadow-pop hover:border-primary/40',
                  w.templateId === t.id && 'border-primary ring-2 ring-primary/20',
                )}
              >
                <h3 className="font-display text-base font-semibold">{t.name}</h3>
                <p className="mt-1.5 text-sm text-muted">{t.description}</p>
              </button>
            ))}
            <button
              onClick={() => pickTemplate(null)}
              className="card flex flex-col justify-center p-5 text-left transition hover:shadow-pop hover:border-primary/40"
            >
              <h3 className="font-display text-base font-semibold">Blank bot</h3>
              <p className="mt-1.5 text-sm text-muted">
                Start from scratch with your own instructions and routines.
              </p>
            </button>
          </div>
        </div>
      )}

      {!loading && step === 1 && (
        <div className="card space-y-6 p-6">
          <Field label="Bot name">
            <input
              className="input"
              value={w.name}
              onChange={(e) => setW({ ...w, name: e.target.value })}
              placeholder="e.g. Inbox Manager"
            />
          </Field>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="label !mb-0">Model provider</span>
              <button className="btn-ghost text-xs font-semibold text-primary" onClick={() => setShowProviderForm((v) => !v)}>
                {showProviderForm ? 'Cancel' : '+ Connect provider'}
              </button>
            </div>
            {providers.length === 0 && !showProviderForm && (
              <p className="text-sm text-muted">No providers yet — connect one to give your bot a brain.</p>
            )}
            <div className="space-y-2">
              {providers.map((p) => (
                <label
                  key={p.id}
                  className={cx(
                    'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm',
                    w.providerId === p.id ? 'border-primary ring-2 ring-primary/20' : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="provider"
                    checked={w.providerId === p.id}
                    onChange={() => setW({ ...w, providerId: p.id })}
                    className="accent-primary"
                  />
                  <span className="font-medium">{p.name}</span>
                  <Badge tone="gray">{p.kind}</Badge>
                  <span className="ml-auto font-mono text-xs text-muted">{p.model}</span>
                </label>
              ))}
            </div>

            {showProviderForm && (
              <div className="mt-4 space-y-4 rounded-lg border border-line bg-gray-50/60 p-4">
                <div className="flex flex-wrap gap-2">
                  {MODEL_PRESETS.map((p) => (
                    <button key={p.id} type="button" className="btn-secondary !py-1.5 text-xs" onClick={() => applyPreset(p.id)}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <input className="input" value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} placeholder="My OpenAI key" />
                  </Field>
                  <Field label="Kind">
                    <select className="input" value={pf.kind} onChange={(e) => setPf({ ...pf, kind: e.target.value as ModelProviderKind })}>
                      <option value="openai_compatible">OpenAI-compatible</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="ollama">Ollama</option>
                    </select>
                  </Field>
                  <Field label="Base URL">
                    <input className="input font-mono" value={pf.base_url} onChange={(e) => setPf({ ...pf, base_url: e.target.value })} />
                  </Field>
                  <Field label="Default model">
                    <input className="input font-mono" value={pf.model} onChange={(e) => setPf({ ...pf, model: e.target.value })} />
                  </Field>
                </div>
                <Field label="API key" hint="Stored on your server, never leaves your machine.">
                  <input className="input font-mono" type="password" value={pf.api_key} onChange={(e) => setPf({ ...pf, api_key: e.target.value })} placeholder={pf.kind === 'ollama' ? 'Not needed for Ollama' : 'sk-…'} />
                </Field>
                <button className="btn-primary" onClick={saveProvider} disabled={savingProvider || !pf.model}>
                  {savingProvider && <Spinner size={14} className="text-white" />} Save provider
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="label !mb-0">Sandbox</span>
              <button className="btn-ghost text-xs font-semibold text-primary" onClick={() => setShowSandboxForm((v) => !v)}>
                {showSandboxForm ? 'Cancel' : '+ Add sandbox'}
              </button>
            </div>
            <div className="space-y-2">
              {sandboxes.map((s) => (
                <label
                  key={s.id}
                  className={cx(
                    'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm',
                    w.sandboxId === s.id ? 'border-primary ring-2 ring-primary/20' : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="sandbox"
                    checked={w.sandboxId === s.id}
                    onChange={() => setW({ ...w, sandboxId: s.id })}
                    className="accent-primary"
                  />
                  <span className="font-medium">{s.name}</span>
                  <Badge tone="gray">{s.kind}</Badge>
                </label>
              ))}
              {sandboxes.length === 0 && !showSandboxForm && (
                <p className="text-sm text-muted">No sandboxes yet — add one so your bot can do real work.</p>
              )}
            </div>
            {showSandboxForm && (
              <div className="mt-4 space-y-4 rounded-lg border border-line bg-gray-50/60 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <input className="input" value={sf.name} onChange={(e) => setSf({ ...sf, name: e.target.value })} placeholder="Local Docker" />
                  </Field>
                  <Field label="Kind">
                    <select className="input" value={sf.kind} onChange={(e) => setSf({ ...sf, kind: e.target.value })}>
                      {sandboxKinds.map((k) => (
                        <option key={k.kind} value={k.kind}>
                          {k.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {sandboxKinds.find((k) => k.kind === sf.kind)?.description && (
                  <p className="text-xs text-muted">{sandboxKinds.find((k) => k.kind === sf.kind)?.description}</p>
                )}
                <button className="btn-primary" onClick={saveSandbox} disabled={savingSandbox}>
                  {savingSandbox && <Spinner size={14} className="text-white" />} Save sandbox
                </button>
              </div>
            )}
          </div>

          <div className="flex justify-between border-t border-line pt-5">
            <button className="btn-secondary" onClick={() => setStep(0)}>
              Back
            </button>
            <button className="btn-primary" onClick={() => setStep(2)} disabled={!canContinueStep1}>
              Continue
            </button>
          </div>
        </div>
      )}

      {!loading && step === 2 && (
        <div className="card p-6">
          <Field
            label="Routines (Markdown)"
            hint="Standing instructions your bot follows every turn — written in plain Markdown."
          >
            <textarea
              className="input min-h-[280px] font-mono text-[13px] leading-6"
              value={w.routinesMd}
              onChange={(e) => setW({ ...w, routinesMd: e.target.value })}
              placeholder={'# Morning routine\n\n- Check the inbox for unread mail\n- Summarize anything urgent\n- Draft replies for my approval'}
            />
          </Field>
          <div className="mt-6 flex justify-between border-t border-line pt-5">
            <button className="btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn-primary" onClick={create} disabled={creating || !canContinueStep1}>
              {creating && <Spinner size={16} className="text-white" />}
              Create bot
            </button>
          </div>
        </div>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        <Link to="/" className="link">Cancel and go back</Link>
      </p>
    </div>
  );
}
