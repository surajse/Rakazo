import { useEffect, useMemo, useState } from 'react';
import { get } from '../api/client';
import type { ApiError, AuditEntry, AuditRecord, Bot } from '../api/types';
import { toAuditEntry } from '../api/types';
import { EmptyState, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../lib/utils';

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [botFilter, setBotFilter] = useState('');
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([
        get<AuditRecord[]>('/api/audit?limit=100'),
        get<Bot[]>('/api/bots'),
      ]);
      const botNames = new Map(b.map((x) => [x.id, x.name]));
      setEntries(a.map(toAuditEntry).map((e) => ({ ...e, bot_name: e.bot_id ? botNames.get(e.bot_id) ?? null : null })));
      setBots(b);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (botFilter && e.bot_id !== botFilter) return false;
      if (q && !`${e.action} ${e.actor} ${e.details ?? ''} ${e.bot_name ?? ''}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [entries, botFilter, query]);

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every sensitive action, recorded. Yours to inspect." />

      <div className="card mb-4 flex flex-wrap gap-3 p-4">
        <select className="input !w-auto min-w-[180px]" value={botFilter} onChange={(e) => setBotFilter(e.target.value)}>
          <option value="">All bots</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          className="input !w-auto min-w-[220px] flex-1"
          placeholder="Filter by action, actor, details…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner size={28} />
        </div>
      )}

      {!loading && error && (
        <EmptyState title="Could not load audit log" body={error} action={<button className="btn-secondary" onClick={load}>Retry</button>} />
      )}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          title="No audit entries"
          body="Actions your bots take — commands run, files changed, messages sent — are recorded here."
        />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-gray-50/60 text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-semibold">Time</th>
                  <th className="px-4 py-3 font-semibold">Actor</th>
                  <th className="px-4 py-3 font-semibold">Bot</th>
                  <th className="px-4 py-3 font-semibold">Action</th>
                  <th className="px-4 py-3 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-gray-50/50">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{formatDateTime(e.time)}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{e.actor}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">{e.bot_name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs font-semibold">{e.action}</td>
                    <td className="max-w-md px-4 py-3 text-xs text-muted break-words">{e.details ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
