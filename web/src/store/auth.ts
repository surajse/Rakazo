import { create } from 'zustand';
import { clearTokens, get, post, setTokens } from '../api/client';
import type { User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: false,
  initialized: false,
  error: null,

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const tokens = await post<{ access_token: string; refresh_token: string }>(
        '/api/auth/login',
        { email, password },
      );
      setTokens(tokens);
      const user = await get<User>('/api/me');
      set({ user, loading: false, initialized: true });
    } catch (e) {
      set({
        loading: false,
        initialized: true,
        error: e instanceof Error ? e.message : 'Login failed',
      });
      throw e;
    }
  },

  signup: async (name, email, password) => {
    set({ loading: true, error: null });
    try {
      const tokens = await post<{ access_token: string; refresh_token: string }>(
        '/api/auth/signup',
        { name, email, password },
      );
      setTokens(tokens);
      const user = await get<User>('/api/me');
      set({ user, loading: false, initialized: true });
    } catch (e) {
      set({
        loading: false,
        initialized: true,
        error: e instanceof Error ? e.message : 'Signup failed',
      });
      throw e;
    }
  },

  logout: () => {
    clearTokens();
    set({ user: null });
  },

  refreshUser: async () => {
    try {
      const user = await get<User>('/api/me');
      set({ user, initialized: true });
    } catch {
      set({ user: null, initialized: true });
    }
  },
}));
