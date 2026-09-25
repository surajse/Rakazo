import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '@/api/client';
import type { Bot, BotTemplate } from '@/api/types';
import { BotCard } from '@/components/BotCard';
import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';
import { Field, PrimaryButton } from '@/components/forms';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function BotsScreen() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setBots(await api.listBots());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load bots');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openBot = (bot: Bot) => {
    router.push({ pathname: '/bot/[id]', params: { id: bot.id } });
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>Your bots</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => setCreateOpen(true)} activeOpacity={0.8}>
          <Text style={styles.addText}>+ New</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <EmptyState title="Couldn't load bots" body={error} />
      ) : bots.length === 0 ? (
        <EmptyState
          title="No bots yet"
          body="Create your first bot to put an AI teammate to work."
        />
      ) : (
        <FlatList
          data={bots}
          keyExtractor={(b) => b.id}
          renderItem={({ item }) => <BotCard bot={item} onPress={() => openBot(item)} />}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.primary} />}
        />
      )}
      <CreateBotModal visible={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load(); }} />
    </Screen>
  );
}

function CreateBotModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting form each time the modal opens
    setName('');
    setTemplateId(null);
    setError(null);
    void api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [visible]);

  const create = async () => {
    if (!name.trim()) {
      setError('Give your bot a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const bot = await api.createBot({ name: name.trim(), template: templateId ?? undefined });
      onCreated(bot);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create bot');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>New bot</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Text style={styles.modalClose}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.modalBody}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Field label="Name" value={name} onChangeText={setName} placeholder="Inbox Manager" autoCapitalize="words" />
          <Text style={styles.label}>Template</Text>
          <View style={styles.chips}>
            {templates.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={[styles.chip, templateId === t.id && styles.chipActive]}
                onPress={() => setTemplateId(templateId === t.id ? null : t.id)}
              >
                <Text style={[styles.chipText, templateId === t.id && styles.chipTextActive]}>{t.name}</Text>
              </TouchableOpacity>
            ))}
            {templates.length === 0 ? <Text style={styles.hint}>No templates available.</Text> : null}
          </View>
          <PrimaryButton title="Create bot" onPress={create} loading={saving} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  title: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  addButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addText: { color: '#fff', fontWeight: '700', fontSize: fontSize.sm },
  list: { padding: spacing.md, paddingTop: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  modal: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  modalClose: { fontSize: fontSize.md, fontWeight: '600', color: colors.primary },
  modalBody: { flex: 1, padding: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text, marginBottom: spacing.xs },
  hint: { fontSize: fontSize.sm, color: colors.muted },
  error: { color: colors.accent, fontSize: fontSize.sm, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text },
  chipTextActive: { color: '#fff' },
});
