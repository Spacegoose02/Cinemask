import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken, setSignedOutHandler, type Me } from './api';
import { applyAccountTheme } from './theme';
import { applyAccountLanguage } from './i18n';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  /** True when the session ended while the app was open (expired, revoked, or signed out elsewhere). */
  expired: boolean;
  refresh: () => Promise<void>;
  /** Forgets the signed-in user in this tab, without asking the server. */
  signedOut: (expired?: boolean) => void;
}

const AuthContext = createContext<AuthValue>({ me: null, loading: true, expired: false, refresh: async () => {}, signedOut: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [expired, setExpired] = useState(false);
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const r = await api<{ user: Me; csrfToken: string }>('/api/auth/me');
        setCsrfToken(r.csrfToken);
        applyAccountTheme(r.user.theme);
        applyAccountLanguage(r.user.language);
        setExpired(false);
        return r.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setCsrfToken('');
          return null;
        }
        throw e;
      }
    },
    retry: false,
  });
  const signedOut = (wasExpired = false) => {
    // Several requests can fail at once when a session ends; the first one is enough.
    if (wasExpired && !qc.getQueryData(['me'])) return;
    setCsrfToken('');
    setExpired(wasExpired);
    qc.setQueryData(['me'], null);
    // Nothing from the last account should show to whoever signs in next.
    qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' && query.queryKey[0] !== 'auth-status' });
  };
  useEffect(() => {
    setSignedOutHandler(() => signedOut(true));
    return () => setSignedOutHandler(null);
  });
  const refresh = async () => {
    await qc.invalidateQueries();
  };
  return <AuthContext.Provider value={{ me: q.data ?? null, loading: q.isLoading, expired, refresh, signedOut }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
