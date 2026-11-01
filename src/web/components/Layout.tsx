import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api, hasRole } from '../lib/api';
import { SearchBar } from './SearchBar';
import { useAuth } from '../lib/auth';
import { useLiveUpdates } from '../lib/live';
import { useInstall, useOnline, useUpdateReady } from '../lib/pwa';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-surface-2 text-accent' : 'text-muted hover:text-text'}`;

export function Layout({ children }: { children: ReactNode }) {
  const { me, signedOut } = useAuth();
  const [open, setOpen] = useState(false);
  const live = useLiveUpdates(Boolean(me));
  const online = useOnline();
  const installer = useInstall();
  const update = useUpdateReady();
  const [iosHelp, setIosHelp] = useState(false);
  // The badges update the moment something changes over the live stream; they only fall back to
  // polling when the stream can't connect (a proxy that blocks it, say).
  const fallback = (ms: number) => (live ? false : ms);
  const isManager = hasRole(me, 'manager');
  const dlCount = useQuery({ queryKey: ['download-count'], queryFn: () => api<{ active: number }>('/api/downloads/count'), enabled: isManager, refetchInterval: fallback(15000) });
  const isAdmin = hasRole(me, 'admin');
  const health = useQuery({ queryKey: ['health-summary'], queryFn: () => api<{ level: string | null; problems: number }>('/api/system/health/summary'), enabled: isAdmin, refetchInterval: 300000 });
  const reqCount = useQuery({ queryKey: ['request-count'], queryFn: () => api<{ pending: number }>('/api/requests/count'), enabled: isManager, refetchInterval: fallback(30000) });
  const issueCount = useQuery({ queryKey: ['issue-count'], queryFn: () => api<{ open: number }>('/api/issues/count'), enabled: isManager, refetchInterval: fallback(60000) });
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
  const install =
    installer.mode === 'prompt' ? (
      <button className="btn-primary w-full" onClick={() => void installer.install()}>
        Install app
      </button>
    ) : installer.mode === 'ios' ? (
      <div>
        <button className="btn-secondary w-full" onClick={() => setIosHelp(!iosHelp)} aria-expanded={iosHelp}>
          Add to Home Screen
        </button>
        {iosHelp && <p className="mt-2 text-xs text-muted">In Safari, tap the Share button, then “Add to Home Screen”.</p>}
      </div>
    ) : null;
  const account = (
    <div className="space-y-2 px-3 text-sm">
      {install}
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
      <NavLink to="/issues" className={(p) => `${linkClass(p)} flex items-center`}>
        Problems {badge(issueCount.data?.open)}
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

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-accent' : 'text-muted'}`;
  const tabs = (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Main"
    >
      <NavLink to="/" end className={tabClass} onClick={() => setOpen(false)}>
        <Icon d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        Home
      </NavLink>
      <NavLink to="/library" className={tabClass} onClick={() => setOpen(false)}>
        <Icon d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1-3 15-4-1z" />
        Library
      </NavLink>
      <NavLink to="/discover" className={tabClass} onClick={() => setOpen(false)}>
        <Icon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm4 5-2 6-6 2 2-6z" />
        Discover
      </NavLink>
      <NavLink to="/requests" className={tabClass} onClick={() => setOpen(false)}>
        <Icon d="M5 4h14v16l-7-4-7 4z" />
        Requests
        {reqCount.data?.pending ? (
          <span className="absolute right-1/4 top-1 rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">{reqCount.data.pending}</span>
        ) : null}
      </NavLink>
      <button className={tabClass({ isActive: open })} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon d="M4 6h16M4 12h16M4 18h16" />
        More
      </button>
    </nav>
  );

  return (
    <div className="min-h-screen md:flex">
      {!online && (
        <div className="fixed inset-x-0 top-0 z-30 bg-warning px-4 py-1 text-center text-xs font-medium text-bg" role="status">
          You're offline. Cinemask will catch up when you reconnect.
        </div>
      )}
      {update.ready && (
        <div className="fixed inset-x-0 bottom-20 z-30 mx-auto flex w-fit items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm shadow-lg md:bottom-6" role="status">
          A new version of Cinemask is ready.
          <button className="btn-primary" onClick={update.apply}>
            Reload
          </button>
        </div>
      )}
      <header className="flex items-center border-b border-border bg-surface px-4 py-3 md:hidden">
        <span className="flex items-center gap-2 font-semibold"><img src="/logo-128.png" alt="" className="h-7 w-7" />Cinemask</span>
      </header>
      {open && (
        <>
          <div className="fixed inset-0 z-10 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className="fixed inset-x-0 z-20 max-h-[75vh] space-y-3 overflow-y-auto rounded-t-2xl border-t border-border bg-surface p-3 md:hidden"
            style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom))' }}
          >
            {nav}
            <div className="border-t border-border pt-3">{account}</div>
          </div>
        </>
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
        <main className="p-4 pb-24 md:p-8">{children}</main>
      </div>
      {tabs}
    </div>
  );
}

/** A small line icon for the phone tab bar. */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
