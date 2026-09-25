import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ApiToolCall } from '@/api/types';
import { colors, fontSize, radius, spacing } from '@/theme';

function summarize(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return s.length > 800 ? `${s.slice(0, 800)}…` : s;
  } catch {
    return String(value);
  }
}

/** Compact expandable row rendering a single tool call inside a message. */
export function ToolCallRow({ toolCall }: { toolCall: ApiToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const running = toolCall.status === 'running';
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
      >
        <View style={[styles.pulse, running && styles.pulseRunning]} />
        <Text style={styles.name} numberOfLines={1}>
          {toolCall.name}
        </Text>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.detail}>
          {toolCall.input !== undefined ? (
            <Text style={styles.detailText}>{summarize(toolCall.input)}</Text>
          ) : null}
          {toolCall.output !== undefined ? (
            <Text style={[styles.detailText, styles.output]}>{summarize(toolCall.output)}</Text>
          ) : null}
          {toolCall.input === undefined && toolCall.output === undefined ? (
            <Text style={styles.detailText}>No details</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
    overflow: 'hidden',
  },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.sm },
  pulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.faint, marginRight: spacing.sm },
  pulseRunning: { backgroundColor: colors.primary },
  name: { flex: 1, fontSize: fontSize.sm, fontWeight: '600', color: colors.text, fontFamily: 'monospace' },
  chevron: { fontSize: fontSize.sm, color: colors.muted, marginLeft: spacing.sm },
  detail: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.sm,
    backgroundColor: colors.card,
  },
  detailText: { fontSize: fontSize.xs, color: colors.muted, fontFamily: 'monospace' },
  output: { marginTop: spacing.xs, color: colors.text },
});
