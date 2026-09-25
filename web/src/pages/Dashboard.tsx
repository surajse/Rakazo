import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get } from '../api/client';
import type { ApiError, Bot } from '../api/types';
import { Badge, EmptyState, Modal, PageHeader, Spinner } from '../components/ui';
import { timeAgo } from '../lib/utils';

function statusTone(status: Bot['status']): 'green' | 'amber' | 'gray' {
  return status === 'active' ? 'green' : status === 'paused' ? 'amber' : 'gray';
}

export function DashboardPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Bot | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await get<Bot[]>('/api/bots');
      setBots(data);
    } catch (e) {
      const err = e as ApiError;
      setError(
        err.status === 0
          ? 'Cannot reach the Rakazo API. Start the backend (docker compose up) and refresh.'
          : err.message,
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (bot: Bot) => {
    try {
      await del(`/api/bots/${bot.id}`);
      setBots((prev) => prev.filter((b) => b.id !== bot.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setConfirmDelete(null);
    }
  };

  const byId = new Map(bots.map((b) => [b.id, b]));

  return (
    <div>
      <PageHeader
        title="Your bots"
        subtitle="AI teammates that work for you, on your machine."
        action={
          <Link to="/bots/new" className="btn-primary">
            New bot
          </Link>
        }
      />

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner size={28} />
        </div>
      )}

      {!loading && error && (
        <EmptyState
          title="Backend unreachable"
          body={error}
          action={
            <button className="btn-secondary" onClick={load}>
              Retry
            </button>
          }
        />
      )}

      {!loading && !error && bots.length === 0 && (
        <EmptyState
          title="No bots yet"
          body="Create your first bot, connect your own model, and give it a sandbox to work in. It will keep one ongoing thread, remember what matters, and ask for approval before risky actions."
          action={
            <Link to="/bots/new" className="btn-primary">
              Create your first bot
            </Link>
          }
        />
      )}

      {!loading && !error && bots.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <div key={bot.id} className="card flex flex-col p-5 transition hover:shadow-pop">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/bots/${bot.id}`} className="min-w-0">
                  <h3 className="truncate font-display text-base font-semibold hover:text-primary">
                    {bot.name}
                  </h3>
                </Link>
                <Badge tone={statusTone(bot.status)}>{bot.status}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {bot.template && <Badge tone="blue">{bot.template.replace(/_/g, ' ')}</Badge>}
                {bot.parent_bot_id && (
                  <Badge tone="gray">
                    sub-bot of {byId.get(bot.parent_bot_id)?.name ?? 'another bot'}
                  </Badge>
                )}
              </div>
              <p className="mt-3 text-xs text-muted">
                Last activity: {timeAgo(bot.last_activity_at)}
              </p>
              <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
                <Link to={`/bots/${bot.id}`} className="btn-secondary !py-1.5 text-xs flex-1">
                  Open thread
                </Link>
                <Link to={`/bots/${bot.id}/settings`} className="btn-ghost text-xs">
                  Settings
                </Link>
                <button
                  className="btn-ghost !text-red-600 text-xs"
                  onClick={() => setConfirmDelete(bot)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete bot">
        <p className="text-sm text-ink">
          Delete <strong>{confirmDelete?.name}</strong>? Its thread, memory, and sub-bots will be
          removed. This cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => confirmDelete && remove(confirmDelete)}>
            Delete bot
          </button>
        </div>
      </Modal>
    </div>
  );
}
