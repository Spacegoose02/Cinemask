import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken, type Me } from './api';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({ me: null, loading: true, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const r = await api<{ user: Me; csrfToken: string }>('/api/auth/me');
        setCsrfToken(r.csrfToken);
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
  const refresh = async () => {
    await qc.invalidateQueries();
  };
  return <AuthContext.Provider value={{ me: q.data ?? null, loading: q.isLoading, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
