import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ApprovalsProvider } from '@/store/approvals';
import { AuthProvider, useAuth } from '@/store/auth';
import { wireNotificationResponses } from '@/store/notifications';
import { colors } from '@/theme';

SplashScreen.preventAutoHideAsync();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;
    const inAuthGroup = segments[0] === '(auth)';
    if (status === 'signed-out' && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (status === 'signed-in' && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [status, segments, router]);

  useEffect(() => {
    if (status !== 'loading') {
      void SplashScreen.hideAsync();
    }
  }, [status]);

  if (status === 'loading') return null;
  return <>{children}</>;
}

function NotificationWiring() {
  const router = useRouter();
  useEffect(
    () =>
      wireNotificationResponses((route) => {
        router.push(route as never);
      }),
    [router],
  );
  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ApprovalsProvider>
        <NotificationWiring />
        <StatusBar style="dark" />
        <AuthGate>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="bot/[id]"
              options={{
                headerShown: true,
                headerBackTitle: 'Bots',
                headerTintColor: colors.primary,
                headerStyle: { backgroundColor: colors.card },
                headerTitleStyle: { color: colors.text },
              }}
            />
          </Stack>
        </AuthGate>
      </ApprovalsProvider>
    </AuthProvider>
  );
}
