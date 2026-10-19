import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ActivitySettings } from './settings/Activity';
import { BackupSettings } from './settings/Backups';
import { GeneralSettings } from './settings/General';
import { SignInSettings } from './settings/SignIn';
import { UserSettings } from './settings/Users';

// All settings live under one page with tabs, so nothing is scattered around the app.
const TABS = [
  { path: 'general', label: 'General', element: <GeneralSettings /> },
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
