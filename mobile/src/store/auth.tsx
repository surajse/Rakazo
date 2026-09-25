/**
 * AuthProvider — owns the session: JWT tokens in SecureStore, the current
 * user, and the configurable API base URL in AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, AuthError } from '@/api/client';
import type { TokenPair, User } from '@/api/types';

const ACCESS_KEY = 'rakazo.access_token';
const REFRESH_KEY = 'rakazo.refresh_token';
const BASE_URL_KEY = 'rakazo.base_url';

export const DEFAULT_BASE_URL = 'http://localhost:8000';

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  baseUrl: string;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
  setBaseUrl: (url: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [baseUrl, setBaseUrlState] = useState<string>(DEFAULT_BASE_URL);

  const saveTokens = useCallback(async (tokens: TokenPair) => {
    await SecureStore.setItemAsync(ACCESS_KEY, tokens.access_token);
    await SecureStore.setItemAsync(REFRESH_KEY, tokens.refresh_token);
  }, []);

  const clearTokens = useCallback(async () => {
    await SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {});
    await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
  }, []);

  // Wire the API client to storage exactly once.
  useEffect(() => {
    api.configure({
      getAccessToken: () => SecureStore.getItemAsync(ACCESS_KEY),
      getRefreshToken: () => SecureStore.getItemAsync(REFRESH_KEY),
      saveTokens,
      clearTokens,
      getBaseUrl: async () => (await AsyncStorage.getItem(BASE_URL_KEY)) ?? DEFAULT_BASE_URL,
    });
  }, [saveTokens, clearTokens]);

  const loadSession = useCallback(async () => {
    try {
      const storedBase = await AsyncStorage.getItem(BASE_URL_KEY);
      if (storedBase) setBaseUrlState(storedBase);
      const access = await SecureStore.getItemAsync(ACCESS_KEY);
      if (!access) {
        setStatus('signed-out');
        return;
      }
      try {
        const me = await api.me();
        setUser(me);
        setStatus('signed-in');
      } catch (e) {
        // api.me() already attempted a refresh on 401; a failure here
        // means the refresh token is dead too.
        if (e instanceof AuthError) {
          await clearTokens();
          setUser(null);
          setStatus('signed-out');
        } else {
          // Network down but we hold tokens: stay signed in, show stale UI.
          setStatus('signed-in');
        }
      }
    } catch {
      setStatus('signed-out');
    }
  }, [clearTokens]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time session restore from SecureStore
    void loadSession();
  }, [loadSession]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const tokens = await api.login(email.trim(), password);
      await saveTokens(tokens);
      const me = await api.me();
      setUser(me);
      setStatus('signed-in');
    },
    [saveTokens],
  );

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      const tokens = await api.signup(email.trim(), password, name?.trim() || undefined);
      await saveTokens(tokens);
      const me = await api.me();
      setUser(me);
      setStatus('signed-in');
    },
    [saveTokens],
  );

  const signOut = useCallback(async () => {
    await clearTokens();
    setUser(null);
    setStatus('signed-out');
  }, [clearTokens]);

  const setBaseUrl = useCallback(async (url: string) => {
    const normalized = url.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
    await AsyncStorage.setItem(BASE_URL_KEY, normalized);
    setBaseUrlState(normalized);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      // keep existing user on transient errors
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, baseUrl, signIn, signUp, signOut, setBaseUrl, refreshUser }),
    [status, user, baseUrl, signIn, signUp, signOut, setBaseUrl, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
