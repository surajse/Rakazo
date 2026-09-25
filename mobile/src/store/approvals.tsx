/**
 * ApprovalsProvider — keeps the pending-approval count fresh so the tab
 * badge stays accurate. Polls while signed in and exposes a manual refresh
 * for pull-to-refresh and screen focus.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { useAuth } from './auth';

interface ApprovalsContextValue {
  pendingCount: number;
  refresh: () => Promise<void>;
}

const ApprovalsContext = createContext<ApprovalsContextValue | null>(null);

const POLL_INTERVAL_MS = 30_000;

export function ApprovalsProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const signedIn = status === 'signed-in';

  const refresh = useCallback(async () => {
    if (status !== 'signed-in') {
      setPendingCount(0);
      return;
    }
    try {
      const approvals = await api.listApprovals('pending');
      setPendingCount(approvals.length);
    } catch {
      // keep last known count on transient errors
    }
  }, [status]);

  useEffect(() => {
    if (!signedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived cache on sign-out
      setPendingCount(0);
      return;
    }
    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [signedIn, refresh]);

  const value = useMemo(() => ({ pendingCount, refresh }), [pendingCount, refresh]);
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

export function useApprovals(): ApprovalsContextValue {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) throw new Error('useApprovals must be used within ApprovalsProvider');
  return ctx;
}
