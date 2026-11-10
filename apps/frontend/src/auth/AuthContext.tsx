import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';

interface User {
  id: string;
  email: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Emails a sign-in code to the account; resolves to the masked address it went to. */
  requestLoginCode: () => Promise<string>;
  loginWithCode: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api<{ user: User }>('/api/auth/me');
      setUser(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setUser(user);
  }, []);

  const requestLoginCode = useCallback(async () => {
    const { sentTo } = await api<{ sentTo: string }>('/api/auth/login-code/request', { method: 'POST', body: {} });
    return sentTo;
  }, []);

  const loginWithCode = useCallback(async (code: string) => {
    const { user } = await api<{ user: User }>('/api/auth/login-code/verify', {
      method: 'POST',
      body: { code },
    });
    setUser(user);
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, requestLoginCode, loginWithCode, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
