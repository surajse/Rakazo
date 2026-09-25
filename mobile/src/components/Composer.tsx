import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, fontSize, radius, spacing } from '@/theme';

interface ComposerProps {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/** Message composer with a stop button that appears while a run streams. */
export function Composer({ streaming, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setText('');
    onSend(trimmed);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.bar}>
        {streaming ? (
          <TouchableOpacity style={styles.stopButton} onPress={onStop} activeOpacity={0.8}>
            <Text style={styles.stopText}>Stop</Text>
          </TouchableOpacity>
        ) : null}
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message your bot…"
          placeholderTextColor={colors.faint}
          multiline
          maxLength={8000}
          editable={!streaming}
          onSubmitEditing={send}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!text.trim() || streaming) && styles.sendDisabled]}
          onPress={send}
          disabled={!text.trim() || streaming}
          activeOpacity={0.8}
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: fontSize.md,
    color: colors.text,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginLeft: spacing.sm,
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: '#fff', fontWeight: '700', fontSize: fontSize.md },
  stopButton: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: spacing.sm,
    justifyContent: 'center',
  },
  stopText: { color: colors.accent, fontWeight: '700', fontSize: fontSize.md },
});
