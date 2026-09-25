import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../api/client';
import type { ApiError, Bot } from '../api/types';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { timeAgo } from '../lib/utils';

export function SubBotsPage() {
  const { id } = useParams<{ id: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [subbots, setSubbots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [b, s] = await Promise.all([
        get<Bot>(`/api/bots/${id}`),
        get<Bot[]>(`/api/bots/${id}/subbots`),
      ]);
      setBot(b);
      setSubbots(s);
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

  const spawn = async () => {
    if (!id || !name.trim() || !task.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await post<{ bot: Bot; run_id: string }>(`/api/bots/${id}/subbots`, {
        name: name.trim(),
        task: task.trim(),
      });
      setSubbots((prev) => [...prev, res.bot]);
      setName('');
      setTask('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not spawn sub-bot');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={`Sub-bots of ${bot?.name ?? 'bot'}`}
        subtitle="Bots this bot spawns to delegate work. They inherit its model and sandbox."
        action={
          <Link to={`/bots/${id}`} className="btn-secondary">
            Back to thread
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}

      <div className="card mb-6 p-5">
        <h3 className="font-display text-base font-semibold">Spawn a sub-bot</h3>
        <div className="mt-3 flex flex-col gap-2">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Research helper"
          />
          <textarea
            className="input min-h-[72px]"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What should it do first? e.g. Summarize the Q3 sales CSV and report the top 3 trends."
          />
          <button className="btn-primary self-start" onClick={spawn} disabled={creating || !name.trim() || !task.trim()}>
            {creating && <Spinner size={14} className="text-white" />} Spawn
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Short-lived helpers can also be spawned automatically inside a turn — those show up here too.
        </p>
      </div>

      {subbots.length === 0 ? (
        <EmptyState
          title="No sub-bots yet"
          body="When this bot delegates work, its sub-bots appear here with their own threads and history."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {subbots.map((s) => (
            <Link key={s.id} to={`/bots/${s.id}`} className="card block p-5 transition hover:shadow-pop">
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate font-display text-base font-semibold">{s.name}</h3>
                <Badge tone={s.status === 'active' ? 'green' : 'gray'}>{s.status}</Badge>
              </div>
              <p className="mt-2 text-xs text-muted">Last activity: {timeAgo(s.last_activity_at)}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
