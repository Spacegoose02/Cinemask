import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api, hasRole } from '../lib/api';
import { SearchBar } from './SearchBar';
import { useAuth } from '../lib/auth';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-surface-2 text-accent' : 'text-muted hover:text-text'}`;

export function Layout({ children }: { children: ReactNode }) {
  const { me, signedOut } = useAuth();
  const [open, setOpen] = useState(false);
  const isManager = hasRole(me, 'manager');
  const dlCount = useQuery({ queryKey: ['download-count'], queryFn: () => api<{ active: number }>('/api/downloads/count'), enabled: isManager, refetchInterval: 15000 });
  const isAdmin = hasRole(me, 'admin');
  const health = useQuery({ queryKey: ['health-summary'], queryFn: () => api<{ level: string | null; problems: number }>('/api/system/health/summary'), enabled: isAdmin, refetchInterval: 300000 });
  const reqCount = useQuery({ queryKey: ['request-count'], queryFn: () => api<{ pending: number }>('/api/requests/count'), enabled: isManager, refetchInterval: 30000 });
  const badge = (n: number | undefined) => (n ? <span className="ml-auto rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg">{n}</span> : null);

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Already signed out on the server (expired, say): still sign out here.
    } finally {
      signedOut();
    }
  };
  const account = (
    <div className="space-y-2 px-3 text-sm">
      <div className="text-muted">
        {me?.displayName || me?.username} · {me?.role}
      </div>
      <button className="btn-secondary w-full" onClick={logout}>
        Sign out
      </button>
    </div>
  );

  const nav = (
    <nav className="space-y-1" onClick={() => setOpen(false)}>
      <NavLink to="/" end className={linkClass}>
        Home
      </NavLink>
      <NavLink to="/library" className={linkClass}>
        Library
      </NavLink>
      <NavLink to="/discover" className={linkClass}>
        Discover
      </NavLink>
      <NavLink to="/collections" className={linkClass}>
        Collections
      </NavLink>
      <NavLink to="/lists" className={linkClass}>
        Lists
      </NavLink>
      <NavLink to="/books" className={linkClass}>
        Books
      </NavLink>
      <NavLink to="/calendar" className={linkClass}>
        Calendar
      </NavLink>
      <NavLink to="/requests" className={(p) => `${linkClass(p)} flex items-center`}>
        Requests {badge(reqCount.data?.pending)}
      </NavLink>
      <NavLink to="/movie-nights" className={linkClass}>
        Movie nights
      </NavLink>
      <NavLink to="/games" className={linkClass}>
        Games
      </NavLink>
      <NavLink to="/wrapped" className={linkClass}>
        Wrapped
      </NavLink>
      {isManager && (
        <NavLink to="/monitored" className={linkClass}>
          Monitored
        </NavLink>
      )}
      {isManager && (
        <NavLink to="/downloads" className={(p) => `${linkClass(p)} flex items-center`}>
          Downloads {badge(dlCount.data?.active)}
        </NavLink>
      )}
      {isManager && (
        <NavLink to="/youtube" className={linkClass}>
          YouTube
        </NavLink>
      )}
      {isAdmin && (
        <NavLink to="/settings" className={(p) => `${linkClass(p)} flex items-center`}>
          Settings
          {health.data?.problems ? (
            <span className={`ml-auto h-2 w-2 rounded-full ${health.data.level === 'error' ? 'bg-danger' : 'bg-warning'}`} title={`${health.data.problems} health problem(s)`} />
          ) : null}
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
        <span className="flex items-center gap-2 font-semibold"><img src="/logo-128.png" alt="" className="h-7 w-7" />Cinemask</span>
        <button className="btn-secondary" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          ☰
        </button>
      </header>
      {open && (
        <div className="space-y-3 border-b border-border bg-surface p-3 md:hidden">
          {nav}
          <div className="border-t border-border pt-3">{account}</div>
        </div>
      )}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold"><img src="/logo-128.png" alt="" className="h-9 w-9" />Cinemask</div>
        {nav}
        <div className="mt-auto">{account}</div>
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
