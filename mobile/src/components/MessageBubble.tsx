import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ApiToolCall } from '@/api/types';
import { colors, fontSize, radius, spacing } from '@/theme';
import { ToolCallRow } from './ToolCallRow';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  toolCalls?: ApiToolCall[];
  streaming?: boolean;
  error?: string;
}

export function MessageBubble({ message }: { message: UiMessage }) {
  if (message.role === 'system') {
    return (
      <View style={styles.systemWrap}>
        <Text style={styles.systemText}>{message.content}</Text>
      </View>
    );
  }
  const isUser = message.role === 'user';
  return (
    <View style={[styles.wrap, isUser ? styles.wrapUser : styles.wrapAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        {message.content ? (
          <Text selectable style={[styles.text, isUser ? styles.textUser : styles.textAssistant]}>
            {message.content}
          </Text>
        ) : null}
        {message.toolCalls?.map((tc) => (
          <ToolCallRow key={tc.id || tc.name} toolCall={tc} />
        ))}
        {message.streaming && !message.content ? (
          <ActivityIndicator size="small" color={colors.primary} style={styles.spinner} />
        ) : null}
        {message.error ? <Text style={styles.errorText}>{message.error}</Text> : null}
      </View>
      <Text style={[styles.time, isUser ? styles.timeUser : styles.timeAssistant]}>
        {formatTime(message.createdAt)}
        {message.streaming ? ' · working' : ''}
      </Text>
    </View>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.sm, paddingHorizontal: spacing.md },
  wrapUser: { alignItems: 'flex-end' },
  wrapAssistant: { alignItems: 'flex-start' },
  bubble: { maxWidth: '88%', borderRadius: radius.md, padding: spacing.sm + 2 },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: radius.sm },
  bubbleAssistant: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: radius.sm,
  },
  text: { fontSize: fontSize.md, lineHeight: 22 },
  textUser: { color: '#fff' },
  textAssistant: { color: colors.text },
  time: { fontSize: fontSize.xs, color: colors.faint, marginTop: 2 },
  timeUser: { textAlign: 'right' },
  timeAssistant: { textAlign: 'left' },
  spinner: { marginVertical: spacing.sm },
  errorText: { fontSize: fontSize.sm, color: colors.accent, marginTop: spacing.xs },
  systemWrap: { alignItems: 'center', marginVertical: spacing.sm, paddingHorizontal: spacing.lg },
  systemText: {
    fontSize: fontSize.xs,
    color: colors.muted,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
    textAlign: 'center',
    overflow: 'hidden',
  },
});
