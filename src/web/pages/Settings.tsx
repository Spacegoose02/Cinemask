import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { LoadError } from '../components/ui';
import { ActivitySettings } from './settings/Activity';
import { ApiSettings } from './settings/ApiSettings';
import { BookSettings } from './settings/Books';
import { BackupSettings } from './settings/Backups';
import { GeneralSettings } from './settings/General';
import { MediaServerSettings } from './settings/MediaServers';
import { DownloadClientSettings } from './settings/DownloadClients';
import { HealthSettings } from './settings/Health';
import { ImportSettings } from './settings/Imports';
import { IndexerSettings } from './settings/Indexers';
import { MediaManagementSettings } from './settings/MediaManagement';
import { MetadataSettings } from './settings/Metadata';
import { ProfileSettings } from './settings/Profiles';
import { RequestSettings } from './settings/Requests';
import { SignInSettings } from './settings/SignIn';
import { UserSettings } from './settings/Users';

// All settings live under one page with tabs, so nothing is scattered around the app.
const TABS = [
  { path: 'general', label: 'General', element: <GeneralSettings /> },
  { path: 'media-servers', label: 'Media servers', element: <MediaServerSettings /> },
  { path: 'metadata', label: 'Metadata', element: <MetadataSettings /> },
  { path: 'media-management', label: 'Media management', element: <MediaManagementSettings /> },
  { path: 'profiles', label: 'Quality', element: <ProfileSettings /> },
  { path: 'indexers', label: 'Indexers', element: <IndexerSettings /> },
  { path: 'download-clients', label: 'Download clients', element: <DownloadClientSettings /> },
  { path: 'books', label: 'Books', element: <BookSettings /> },
  { path: 'import', label: 'Import', element: <ImportSettings /> },
  { path: 'requests', label: 'Requests', element: <RequestSettings /> },
  { path: 'users', label: 'Users', element: <UserSettings /> },
  { path: 'sign-in', label: 'Sign-in', element: <SignInSettings /> },
  { path: 'api', label: 'API and webhooks', element: <ApiSettings /> },
  { path: 'backups', label: 'Backups', element: <BackupSettings /> },
  { path: 'health', label: 'Health', element: <HealthSettings /> },
  { path: 'activity', label: 'Activity log', element: <ActivitySettings /> },
];

// What the settings tabs load. A tab whose data fails shows nothing of its own, so this says why.
const LOADED_HERE = new Set(['settings', 'audit', 'all-api-keys', 'backups', 'clients', 'indexers', 'profiles', 'users']);

function SettingsLoadError() {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const failed = useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () =>
      cache
        .getAll()
        .filter((q) => q.state.status === 'error' && q.getObserversCount() > 0 && LOADED_HERE.has(String(q.queryKey[0])))
        .map((q) => q.queryHash)
        .join('\n'),
  );
  const queries = failed
    ? failed.split('\n').flatMap((hash) => {
        const q = cache.get(hash);
        return q ? [{ error: q.state.error, refetch: () => q.fetch().catch(() => undefined) }] : [];
      })
    : [];
  return <LoadError queries={queries} />;
}

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={`/settings/${t.path}`}
            className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-2 text-sm ${isActive ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      <SettingsLoadError />
      <Routes>
        {TABS.map((t) => (
          <Route key={t.path} path={t.path} element={t.element} />
        ))}
        <Route path="*" element={<Navigate to="general" replace />} />
      </Routes>
    </div>
  );
}
