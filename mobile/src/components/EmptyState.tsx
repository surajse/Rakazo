import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, shadow, spacing } from '@/theme';

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    ...shadow.card,
  },
  title: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, textAlign: 'center' },
  body: { fontSize: fontSize.sm, color: colors.muted, marginTop: spacing.xs, textAlign: 'center' },
});
