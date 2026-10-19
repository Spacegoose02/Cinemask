import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ActivitySettings } from './settings/Activity';
import { BackupSettings } from './settings/Backups';
import { GeneralSettings } from './settings/General';
import { MediaServerSettings } from './settings/MediaServers';
import { DownloadClientSettings } from './settings/DownloadClients';
import { IndexerSettings } from './settings/Indexers';
import { MediaManagementSettings } from './settings/MediaManagement';
import { MetadataSettings } from './settings/Metadata';
import { ProfileSettings } from './settings/Profiles';
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
  { path: 'users', label: 'Users', element: <UserSettings /> },
  { path: 'sign-in', label: 'Sign-in', element: <SignInSettings /> },
  { path: 'backups', label: 'Backups', element: <BackupSettings /> },
  { path: 'activity', label: 'Activity log', element: <ActivitySettings /> },
];

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
      <Routes>
        {TABS.map((t) => (
          <Route key={t.path} path={t.path} element={t.element} />
        ))}
        <Route path="*" element={<Navigate to="general" replace />} />
      </Routes>
    </div>
  );
}
