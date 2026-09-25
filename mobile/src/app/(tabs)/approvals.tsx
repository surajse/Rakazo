import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '@/api/client';
import type { Approval } from '@/api/types';
import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';
import { PrimaryButton } from '@/components/forms';
import { useApprovals } from '@/store/approvals';
import { colors, fontSize, radius, shadow, spacing } from '@/theme';

export default function ApprovalsScreen() {
  const { refresh: refreshBadge } = useApprovals();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        setApprovals(await api.listApprovals('pending'));
        void refreshBadge();
      } catch {
        // keep stale list; badge provider retries on its own schedule
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [refreshBadge],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const decide = async (approval: Approval, decision: 'approve' | 'deny') => {
    setActing(approval.id);
    try {
      if (decision === 'approve') await api.approveApproval(approval.id);
      else await api.denyApproval(approval.id);
      setApprovals((prev) => prev.filter((a) => a.id !== approval.id));
      void refreshBadge();
    } catch (e) {
      Alert.alert('Action failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setActing(null);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>Approvals</Text>
        <Text style={styles.subtitle}>Bots pause here until you say go.</Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : approvals.length === 0 ? (
        <EmptyState title="All caught up" body="No pending approvals. Your bots will ping you here when they need a decision." />
      ) : (
        <FlatList
          data={approvals}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => (
            <ApprovalCard approval={item} busy={acting === item.id} onDecide={(d) => decide(item, d)} />
          )}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.primary} />
          }
        />
      )}
    </Screen>
  );
}

function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: Approval;
  busy: boolean;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.botName} numberOfLines={1}>
          {approval.bot_name ?? 'Bot'}
        </Text>
        <Text style={styles.time}>{formatTime(approval.created_at)}</Text>
      </View>
      <Text style={styles.action}>{approval.action ?? approval.kind}</Text>
      <Text style={styles.description}>{approval.description}</Text>
      <View style={styles.buttons}>
        <View style={styles.buttonFlex}>
          <PrimaryButton title="Deny" variant="ghost" onPress={() => onDecide('deny')} loading={busy} />
        </View>
        <View style={styles.buttonFlex}>
          <PrimaryButton title="Approve" onPress={() => onDecide('approve')} loading={busy} />
        </View>
      </View>
    </View>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  list: { padding: spacing.md, paddingTop: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadow.card,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  botName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },
  time: { fontSize: fontSize.xs, color: colors.faint },
  action: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, marginTop: spacing.xs },
  description: { fontSize: fontSize.sm, color: colors.muted, marginTop: 2, lineHeight: 20 },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  buttonFlex: { flex: 1 },
});
