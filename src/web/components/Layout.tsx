import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, hasRole } from '../lib/api';
import { SearchBar } from './SearchBar';
import { useAuth } from '../lib/auth';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-surface-2 text-accent' : 'text-muted hover:text-text'}`;

export function Layout({ children }: { children: ReactNode }) {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    await refresh();
    navigate('/login');
  };

  const nav = (
    <nav className="space-y-1" onClick={() => setOpen(false)}>
      <NavLink to="/" end className={linkClass}>
        Home
      </NavLink>
      <NavLink to="/library" className={linkClass}>
        Library
      </NavLink>
      {hasRole(me, 'admin') && (
        <NavLink to="/settings" className={linkClass}>
          Settings
        </NavLink>
      )}
      <NavLink to="/account" className={linkClass}>
        Account
      </NavLink>
    </nav>
  );

  return (
    <div className="min-h-screen md:flex">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
        <span className="font-semibold">Media Manager</span>
        <button className="btn-secondary" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          ☰
        </button>
      </header>
      {open && <div className="border-b border-border bg-surface p-3 md:hidden">{nav}</div>}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="mb-6 px-3 text-lg font-semibold">Media Manager</div>
        {nav}
        <div className="mt-auto space-y-2 px-3 text-sm">
          <div className="text-muted">
            {me?.displayName || me?.username} · {me?.role}
          </div>
          <button className="btn-secondary w-full" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-10 border-b border-border bg-bg/90 px-4 py-3 backdrop-blur md:px-8">
          <SearchBar />
        </div>
        <main className="p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
