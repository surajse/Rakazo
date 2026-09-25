import { Link } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field, PrimaryButton } from '@/components/forms';
import { useAuth } from '@/store/auth';
import { colors, fontSize, spacing } from '@/theme';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>Rakazo</Text>
          <Text style={styles.subtitle}>Your AI teammates, on the go.</Text>
          <View style={styles.form}>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              textContentType="emailAddress"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
              textContentType="password"
              onSubmitEditing={submit}
            />
            <PrimaryButton title="Sign in" onPress={submit} loading={loading} />
            <Text style={styles.switchRow}>
              New to Rakazo?{' '}
              <Link href="/(auth)/signup" style={styles.link}>
                Create an account
              </Link>
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  brand: { fontSize: 40, fontWeight: '800', color: colors.text, letterSpacing: -1 },
  subtitle: { fontSize: fontSize.md, color: colors.muted, marginTop: spacing.xs, marginBottom: spacing.xl },
  form: { gap: 0 },
  error: { color: colors.accent, fontSize: fontSize.sm, marginBottom: spacing.sm },
  switchRow: { marginTop: spacing.md, textAlign: 'center', color: colors.muted, fontSize: fontSize.sm },
  link: { color: colors.primary, fontWeight: '700' },
});
