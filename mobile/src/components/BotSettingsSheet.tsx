import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, ApiError } from '@/api/client';
import type { Bot, MemoryNote } from '@/api/types';
import { colors, fontSize, radius, spacing } from '@/theme';
import { Field, PrimaryButton } from './forms';

interface BotSettingsSheetProps {
  botId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Bottom-sheet style modal: edit name + routines markdown, manage memory notes. */
export function BotSettingsSheet({ botId, onClose, onSaved }: BotSettingsSheetProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [routines, setRoutines] = useState('');
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading bot data when the sheet opens
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [bot, memory]: [Bot, MemoryNote[]] = await Promise.all([
          api.getBot(botId),
          api.listMemoryNotes(botId).catch(() => [] as MemoryNote[]),
        ]);
        if (cancelled) return;
        setName(bot.name);
        setRoutines(bot.routines ?? '');
        setNotes(memory);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load bot settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const save = async () => {
    if (!botId || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateBot(botId, { name: name.trim(), routines });
      onSaved();
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? 'This backend does not support editing bots from the app yet.'
          : e instanceof Error
            ? e.message
            : 'Failed to save',
      );
    } finally {
      setSaving(false);
    }
  };

  const addNote = async () => {
    if (!botId || !newNote.trim()) return;
    setAddingNote(true);
    try {
      const value = newNote.trim();
      const key = `note-${Date.now()}`;
      const note = await api.addMemoryNote(botId, key, value);
      setNotes((prev) => [note, ...prev]);
      setNewNote('');
    } catch (e) {
      Alert.alert('Could not add note', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setAddingNote(false);
    }
  };

  const deleteNote = (note: MemoryNote) => {
    if (!botId) return;
    Alert.alert('Delete memory note?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteMemoryNote(botId, note.key);
            setNotes((prev) => prev.filter((n) => n.key !== note.key));
          } catch (e) {
            Alert.alert('Could not delete note', e instanceof Error ? e.message : 'Unknown error');
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={!!botId} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>Bot settings</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </TouchableOpacity>
        </View>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Field label="Name" value={name} onChangeText={setName} placeholder="Bot name" />
            <Text style={styles.label}>Routines (Markdown)</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={routines}
              onChangeText={setRoutines}
              placeholder={'# Morning routine\n- Check inbox\n- Summarize overnight activity'}
              placeholderTextColor={colors.faint}
              multiline
              textAlignVertical="top"
            />
            <PrimaryButton title="Save changes" onPress={save} loading={saving} disabled={!name.trim()} />

            <Text style={[styles.label, styles.section]}>Memory notes</Text>
            <Text style={styles.hint}>Things this bot should remember across sessions.</Text>
            <View style={styles.noteRow}>
              <TextInput
                style={[styles.input, styles.noteInput]}
                value={newNote}
                onChangeText={setNewNote}
                placeholder="Add a memory note…"
                placeholderTextColor={colors.faint}
              />
              <TouchableOpacity
                style={[styles.addButton, !newNote.trim() && styles.addDisabled]}
                onPress={addNote}
                disabled={!newNote.trim() || addingNote}
              >
                {addingNote ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.addText}>Add</Text>
                )}
              </TouchableOpacity>
            </View>
            {notes.map((note) => (
              <View key={note.key} style={styles.noteCard}>
                <Text style={styles.noteText}>{note.value}</Text>
                <TouchableOpacity onPress={() => deleteNote(note)} hitSlop={8}>
                  <Text style={styles.deleteText}>Delete</Text>
                </TouchableOpacity>
              </View>
            ))}
            {notes.length === 0 ? <Text style={styles.hint}>No memory notes yet.</Text> : null}
            <View style={{ height: spacing.xl }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  close: { fontSize: fontSize.md, fontWeight: '600', color: colors.primary },
  body: { flex: 1, padding: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, marginBottom: spacing.xs },
  section: { marginTop: spacing.lg },
  hint: { fontSize: fontSize.sm, color: colors.muted, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.input,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: fontSize.md,
    color: colors.text,
    marginBottom: spacing.md,
  },
  multiline: { minHeight: 160, fontFamily: 'monospace', fontSize: fontSize.sm },
  error: { color: colors.accent, fontSize: fontSize.sm, marginBottom: spacing.sm },
  noteRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  noteInput: { flex: 1, marginBottom: 0 },
  addButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  addDisabled: { opacity: 0.45 },
  addText: { color: '#fff', fontWeight: '700' },
  noteCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  noteText: { flex: 1, fontSize: fontSize.sm, color: colors.text },
  deleteText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.accent },
});
