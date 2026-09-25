import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api } from '@/api/client';
import type { ModelProvider } from '@/api/types';
import { Screen } from '@/components/Screen';
import { Field, PrimaryButton } from '@/components/forms';
import { DEFAULT_BASE_URL, useAuth } from '@/store/auth';
import { enablePushNotifications } from '@/store/notifications';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function SettingsScreen() {
  const { user, baseUrl, setBaseUrl, signOut } = useAuth();
  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [savingUrl, setSavingUrl] = useState(false);
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [pushState, setPushState] = useState<'idle' | 'working' | 'done' | 'denied'>('idle');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing draft with saved URL
    setDraftUrl(baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    void api.listProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  const saveUrl = async () => {
    setSavingUrl(true);
    try {
      await setBaseUrl(draftUrl);
      Alert.alert('Saved', 'API base URL updated. Pull to refresh your bots to reconnect.');
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSavingUrl(false);
    }
  };

  const enablePush = async () => {
    setPushState('working');
    const token = await enablePushNotifications();
    setPushState(token ? 'done' : 'denied');
  };

  const logout = () => {
    Alert.alert('Sign out?', 'You will need to sign in again on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <Screen>
      <ScrollView style={styles.body}>
        <Text style={styles.title}>Settings</Text>

        <Text style={styles.section}>Account</Text>
        <View style={styles.card}>
          <Text style={styles.accountName}>{user?.name ?? 'Rakazo user'}</Text>
          <Text style={styles.accountEmail}>{user?.email}</Text>
        </View>

        <Text style={styles.section}>Server</Text>
        <View style={styles.card}>
          <Field
            label="API base URL"
            value={draftUrl}
            onChangeText={setDraftUrl}
            placeholder={DEFAULT_BASE_URL}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>
            Point this at your backend. On a physical phone use the LAN IP of your computer, e.g.
            http://192.168.1.10:8000 — localhost only works on simulators.
          </Text>
          <PrimaryButton title="Save URL" onPress={saveUrl} loading={savingUrl} />
        </View>

        <Text style={styles.section}>Model providers</Text>
        <View style={styles.card}>
          {providers === null ? (
            <Text style={styles.hint}>Loading…</Text>
          ) : providers.length === 0 ? (
            <Text style={styles.hint}>
              No providers reported by the backend. Connect providers from the web app or backend
              config.
            </Text>
          ) : (
            providers.map((p) => (
              <View key={p.id} style={styles.providerRow}>
                <View style={[styles.dot, { backgroundColor: p.configured ? colors.success : colors.faint }]} />
                <Text style={styles.providerName}>{p.name}</Text>
                <Text style={styles.providerState}>{p.configured ? 'Connected' : 'Not connected'}</Text>
              </View>
            ))
          )}
        </View>

        <Text style={styles.section}>Notifications</Text>
        <View style={styles.card}>
          <Text style={styles.hint}>
            Get pinged when a bot needs your approval. Push registration with the backend is not
            wired yet — enabling only requests permission and fetches a device token for now.
          </Text>
          <PrimaryButton
            title={
              pushState === 'done'
                ? 'Push enabled'
                : pushState === 'denied'
                  ? 'Permission denied — try again'
                  : 'Enable push notifications'
            }
            onPress={enablePush}
            loading={pushState === 'working'}
            disabled={pushState === 'done'}
            variant="ghost"
          />
        </View>

        <TouchableOpacity style={styles.logout} onPress={logout} activeOpacity={0.7}>
          <Text style={styles.logoutText}>Sign out</Text>
        </TouchableOpacity>
        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: spacing.md },
  title: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text, letterSpacing: -0.5, marginBottom: spacing.sm },
  section: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  accountName: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  accountEmail: { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  hint: { fontSize: fontSize.sm, color: colors.muted, lineHeight: 20, marginBottom: spacing.sm },
  providerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: spacing.sm },
  providerName: { flex: 1, fontSize: fontSize.md, fontWeight: '600', color: colors.text },
  providerState: { fontSize: fontSize.sm, color: colors.muted },
  logout: {
    marginTop: spacing.lg,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutText: { color: colors.accent, fontWeight: '700', fontSize: fontSize.md },
});
