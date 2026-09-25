import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { Alert, Field, Spinner } from '../components/ui';
import { checkHealth, API_URL } from '../api/client';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-white">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <circle cx="9" cy="10" r="2.4" fill="currentColor" />
              <circle cx="15" cy="10" r="2.4" fill="currentColor" />
              <rect x="7" y="15" width="10" height="2" rx="1" fill="currentColor" />
            </svg>
          </span>
          <h1 className="mt-4 font-display text-3xl font-bold tracking-tight">Rakazo</h1>
          <p className="mt-1 text-sm text-muted">AI teammates you actually own.</p>
        </div>
        <div className="card p-8">
          <h2 className="font-display text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-xs text-muted">
          Self-hosted and open source. Your keys, your data, your machine.
        </p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, loading, error } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiDown, setApiDown] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await checkHealth().catch(() => false);
    setApiDown(!ok);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch {
      /* error is in store */
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to manage your bots.">
      <form onSubmit={submit} className="space-y-4">
        {apiDown && (
          <Alert kind="error">
            Cannot reach the API at <span className="font-mono">{API_URL}</span>. Make sure the
            backend is running, then try again.
          </Alert>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Email">
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading && <Spinner size={16} className="text-white" />}
          Sign in
        </button>
        <p className="text-center text-sm text-muted">
          New to Rakazo?{' '}
          <Link to="/signup" className="link">
            Create an account
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { signup, loading, error } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiDown, setApiDown] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await checkHealth().catch(() => false);
    setApiDown(!ok);
    try {
      await signup(name.trim(), email.trim(), password);
      navigate('/', { replace: true });
    } catch {
      /* error is in store */
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="Run your first AI teammate in minutes.">
      <form onSubmit={submit} className="space-y-4">
        {apiDown && (
          <Alert kind="error">
            Cannot reach the API at <span className="font-mono">{API_URL}</span>. Make sure the
            backend is running, then try again.
          </Alert>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Name">
          <input
            className="input"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
        </Field>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading && <Spinner size={16} className="text-white" />}
          Create account
        </button>
        <p className="text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
