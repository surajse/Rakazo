/**
 * Push notification setup — stubbed and ready to wire.
 *
 * What works today:
 *  - permission request + Expo push token retrieval
 *  - foreground notification handling (banner + list)
 *  - tap-to-deep-link into the approvals inbox or a bot thread
 *
 * What is NOT wired yet:
 *  - sending the Expo push token to the Rakazo backend. There is no push
 *    registration endpoint in the API contract yet; `registerPushTokenWithBackend`
 *    logs the token and documents the expected call. See README for details.
 *
 * Note: remote push requires a development build or EAS build — it does not
 * work in Expo Go on Android (SDK 53+), and APNs/FCM credentials must be
 * configured in the Expo project.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Foreground behavior: show a banner and keep it in the notification list.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('approvals', {
    name: 'Approvals',
    description: 'Notifications when a bot needs your approval',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/** Ask for permission; returns true when notifications are allowed. */
export async function ensurePushPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted || existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Retrieve the Expo push token for this device, or null when unavailable
 * (simulator, missing EAS project id, permission denied).
 */
export async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log('[push] Skipping push token: not a physical device.');
    return null;
  }
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  if (!projectId) {
    console.log('[push] Skipping push token: no EAS project id configured.');
    return null;
  }
  try {
    await ensureAndroidChannel();
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  } catch (e) {
    console.log('[push] Failed to get Expo push token:', e);
    return null;
  }
}

/**
 * TODO(backend): register the token server-side once the endpoint exists,
 * e.g. POST /api/me/push-tokens { token, platform }.
 */
export async function registerPushTokenWithBackend(token: string): Promise<void> {
  console.log('[push] Token ready for backend registration (not wired yet):', token);
}

/** Full opt-in flow: permission -> token -> (stubbed) backend registration. */
export async function enablePushNotifications(): Promise<string | null> {
  const granted = await ensurePushPermission();
  if (!granted) return null;
  const token = await getExpoPushToken();
  if (token) await registerPushTokenWithBackend(token);
  return token;
}

/**
 * Wire notification taps to deep links. Call once from the root layout.
 * Expected payload: { data: { route: "/(tabs)/approvals" | "/bot/<id>" } }
 */
export function wireNotificationResponses(navigate: (route: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const route = response.notification.request.content.data?.route;
    if (typeof route === 'string' && route.length > 0) navigate(route);
  });
  // Cold-start case: app launched from a killed state via notification tap.
  void (async () => {
    const initial = await Notifications.getLastNotificationResponseAsync();
    const route = initial?.notification.request.content.data?.route;
    if (typeof route === 'string' && route.length > 0) {
      setTimeout(() => navigate(route), 500);
    }
  })();
  return () => sub.remove();
}
