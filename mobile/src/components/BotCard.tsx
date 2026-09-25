import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Bot } from '@/api/types';
import { colors, fontSize, radius, shadow, spacing } from '@/theme';

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return colors.primary;
    case 'waiting_approval':
      return colors.warning;
    case 'error':
      return colors.accent;
    default:
      return colors.success;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Working';
    case 'waiting_approval':
      return 'Needs approval';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
    default:
      return status.replace(/_/g, ' ');
  }
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return 'Never';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function BotCard({ bot, onPress }: { bot: Bot; onPress: () => void }) {
  const dot = statusColor(bot.status);
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{bot.name.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.main}>
          <Text style={styles.name} numberOfLines={1}>
            {bot.name}
          </Text>
          <View style={styles.metaRow}>
            {bot.template ? (
              <View style={styles.chip}>
                <Text style={styles.chipText}>{bot.template}</Text>
              </View>
            ) : null}
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: dot }]} />
              <Text style={styles.statusText}>{statusLabel(bot.status)}</Text>
            </View>
          </View>
        </View>
      </View>
      <Text style={styles.activity}>Last activity: {formatRelative(bot.last_activity_at)}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadow.card,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  avatarText: { color: colors.primary, fontSize: fontSize.lg, fontWeight: '700' },
  main: { flex: 1 },
  name: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs, gap: spacing.sm },
  chip: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipText: { fontSize: fontSize.xs, color: colors.muted, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: fontSize.xs, color: colors.muted, fontWeight: '600' },
  activity: { fontSize: fontSize.xs, color: colors.faint, marginTop: spacing.sm },
});
