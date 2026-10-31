import { ApiDocsPage } from './pages/ApiDocs';
import { BooksPage } from './pages/Books';
import { YoutubePage } from './pages/Youtube';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { api, hasRole, type AuthStatus, type Role } from './lib/api';
import { useAuth } from './lib/auth';
import { FamilyPanel } from './components/FamilyPanel';
import { FilesPanel } from './components/FilesPanel';
import { MediaActions } from './components/MediaActions';
import { CalendarPage } from './pages/Calendar';
import { CollectionDetailPage, CollectionsPage } from './pages/Collections';
import { DiscoverPage } from './pages/Discover';
import { ListDetailPage, ListsPage } from './pages/Lists';
import { AccountPage } from './pages/Account';
import { DownloadsPage } from './pages/Downloads';
import { GamesPage } from './pages/Games';
import { MovieNightsPage } from './pages/MovieNights';
import { WrappedPage } from './pages/Wrapped';
import { RequestsPage } from './pages/Requests';
import { HomePage } from './pages/Home';
import { LibraryPage } from './pages/Library';
import { LoginPage } from './pages/Login';
import { MediaDetailPage, type MediaDetail } from './pages/MediaDetail';
import { MonitoredPage } from './pages/Monitored';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { SetupPage } from './pages/Setup';

const panels = (m: MediaDetail) => (
  <>
    <FamilyPanel m={m} />
    <FilesPanel m={m} />
  </>
);

/** Where to go after signing in: the page they first asked for, if it's one of ours. */
function afterSignIn(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/';
}

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
        {/* Remember where they were going, so a shared link still opens after signing in. */}
        <Route path="*" element={<Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/login" element={<Navigate to={afterSignIn(location.state)} replace />} />
        <Route path="/" element={<HomePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/movie/:tmdbId" element={<MediaDetailPage kind="movie" actions={(m) => <MediaActions m={m} />} panels={panels} />} />
        <Route path="/tv/:tmdbId" element={<MediaDetailPage kind="show" actions={(m) => <MediaActions m={m} />} panels={panels} />} />
        <Route path="/books" element={<BooksPage />} />
        <Route path="/developer" element={<ApiDocsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/lists" element={<ListsPage />} />
        <Route path="/lists/:id" element={<ListDetailPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/collections/:id" element={<CollectionDetailPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/movie-nights" element={<MovieNightsPage />} />
        <Route path="/games" element={<GamesPage />} />
        <Route path="/wrapped" element={<WrappedPage />} />
        <Route
          path="/monitored"
          element={
            <RequireRole role="manager">
              <MonitoredPage />
            </RequireRole>
          }
        />
        <Route
          path="/youtube"
          element={
            <RequireRole role="manager">
              <YoutubePage />
            </RequireRole>
          }
        />
        <Route
          path="/downloads"
          element={
            <RequireRole role="manager">
              <DownloadsPage />
            </RequireRole>
          }
        />
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
