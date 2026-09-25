import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import type { ApiError, Approval } from '../api/types';
import { Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { cx, formatDateTime } from '../lib/utils';

function ApprovalCard({
  approval,
  onDecided,
}: {
  approval: Approval;
  onDecided: (a: Approval) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      const updated = await post<Approval>(`/api/approvals/${approval.id}/${decision}`, {});
      onDecided(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-semibold">{approval.bot_name ?? 'Bot'}</h3>
          <p className="text-xs text-muted">{formatDateTime(approval.created_at)}</p>
        </div>
        <Badge tone={approval.status === 'pending' ? 'amber' : approval.status === 'approved' ? 'green' : 'red'}>
          {approval.status}
        </Badge>
      </div>
      <p className="mt-3 text-sm font-medium">{approval.description ?? approval.action ?? approval.kind}</p>
      {approval.payload && (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-[11px] leading-5 text-gray-100">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {approval.status === 'pending' && (
        <div className="mt-4 flex gap-2">
          <button className="btn-primary !py-2 text-sm" disabled={busy} onClick={() => decide('approve')}>
            Approve
          </button>
          <button className="btn-secondary !py-2 text-sm" disabled={busy} onClick={() => decide('deny')}>
            Deny
          </button>
        </div>
      )}
      {approval.status !== 'pending' && approval.decided_at && (
        <p className="mt-3 text-xs text-muted">Decided {formatDateTime(approval.decided_at)}</p>
      )}
    </div>
  );
}

export function ApprovalsPage() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (which: 'pending' | 'history') => {
    setLoading(true);
    setError(null);
    try {
      const status = which === 'pending' ? 'pending' : 'decided';
      const data = await get<Approval[]>(`/api/approvals?status=${status}`);
      setApprovals(data);
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 0 ? 'Cannot reach the Rakazo API.' : err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const onDecided = (updated: Approval) => {
    setApprovals((prev) =>
      tab === 'pending' ? prev.filter((a) => a.id !== updated.id) : prev.map((a) => (a.id === updated.id ? updated : a)),
    );
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Approvals"
        subtitle="Bots pause here before risky actions. Nothing runs without your say-so."
      />

      <div className="mb-6 flex gap-1 border-b border-line">
        {(['pending', 'history'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              'px-4 py-2.5 text-sm font-medium capitalize transition',
              tab === t ? 'border-b-2 border-primary text-primary-dark' : 'text-muted hover:text-ink',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner size={28} />
        </div>
      )}

      {!loading && error && (
        <EmptyState title="Could not load approvals" body={error} action={<button className="btn-secondary" onClick={() => load(tab)}>Retry</button>} />
      )}

      {!loading && !error && approvals.length === 0 && (
        <EmptyState
          title={tab === 'pending' ? 'All clear' : 'No history yet'}
          body={
            tab === 'pending'
              ? 'No pending approvals. When a bot wants to do something sensitive — run a command, change a file, send a message — it will wait here.'
              : 'Approved and denied requests will appear here.'
          }
        />
      )}

      {!loading && !error && approvals.length > 0 && (
        <div className="space-y-4">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={onDecided} />
          ))}
        </div>
      )}
    </div>
  );
}
