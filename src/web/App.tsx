import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { api, hasRole, type AuthStatus, type Role } from './lib/api';
import { useAuth } from './lib/auth';
import { AccountPage } from './pages/Account';
import { HomePage } from './pages/Home';
import { LibraryPage } from './pages/Library';
import { LoginPage } from './pages/Login';
import { MediaDetailPage } from './pages/MediaDetail';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { SetupPage } from './pages/Setup';

function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { me } = useAuth();
  if (!hasRole(me, role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const { me, loading } = useAuth();
  const location = useLocation();
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<AuthStatus>('/api/auth/status') });

  if (loading || status.isLoading) return <div className="p-8 text-muted">Loading…</div>;
  if (status.data?.needsSetup) return location.pathname === '/setup' ? <SetupPage /> : <Navigate to="/setup" replace />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage status={status.data!} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/movie/:tmdbId" element={<MediaDetailPage kind="movie" />} />
        <Route path="/tv/:tmdbId" element={<MediaDetailPage kind="show" />} />
        <Route path="/account" element={<AccountPage />} />
        <Route
          path="/settings/*"
          element={
            <RequireRole role="admin">
              <SettingsPage />
            </RequireRole>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
