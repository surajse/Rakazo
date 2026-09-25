import { Link } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field, PrimaryButton } from '@/components/forms';
import { useAuth } from '@/store/auth';
import { colors, fontSize, spacing } from '@/theme';

export default function SignupScreen() {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and a password.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await signUp(email, password, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign up failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>Rakazo</Text>
          <Text style={styles.subtitle}>Create your account to meet your bots.</Text>
          <View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="Ada Lovelace"
              autoCapitalize="words"
              textContentType="name"
            />
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
              placeholder="At least 8 characters"
              secureTextEntry
              textContentType="newPassword"
              onSubmitEditing={submit}
            />
            <PrimaryButton title="Create account" onPress={submit} loading={loading} />
            <Text style={styles.switchRow}>
              Already have an account?{' '}
              <Link href="/(auth)/login" style={styles.link}>
                Sign in
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
  error: { color: colors.accent, fontSize: fontSize.sm, marginBottom: spacing.sm },
  switchRow: { marginTop: spacing.md, textAlign: 'center', color: colors.muted, fontSize: fontSize.sm },
  link: { color: colors.primary, fontWeight: '700' },
});
