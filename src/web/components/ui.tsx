import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="block">
        <span className="label">{label}</span>
        {children}
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--mm-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="hint block">{hint}</span>}
      </span>
    </label>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const color = kind === 'error' ? 'border-danger/50 text-danger' : kind === 'success' ? 'border-success/50 text-success' : 'border-border text-muted';
  return <div className={`rounded-md border px-3 py-2 text-sm ${color}`}>{children}</div>;
}

/** Secret input: never shows the stored value, only whether one is set. */
export function SecretInput({ isSet, value, onChange, placeholder }: { isSet: boolean; value: string | null | undefined; onChange: (v: string | null | undefined) => void; placeholder?: string }) {
  return (
    <div className="flex gap-2">
      <input
        type="password"
        autoComplete="new-password"
        className="input"
        placeholder={isSet && value === undefined ? '•••••••• (saved)' : placeholder}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
      {isSet && (
        <button type="button" className="btn-secondary" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </div>
  );
}

/** Says when a page's data couldn't be loaded, instead of leaving it blank, with a way to try again. */
export function LoadError({ queries }: { queries: { error: unknown; refetch: () => unknown }[] }) {
  // A lost session sends them to sign in, so it needs no message here.
  const failed = queries.filter((q) => q.error && !(q.error instanceof ApiError && q.error.status === 401));
  if (!failed.length) return null;
  return (
    <Alert>
      Couldn't load this: {(failed[0]!.error as Error).message}{' '}
      <button className="underline" onClick={() => failed.forEach((q) => void q.refetch())}>
        Try again
      </button>
    </Alert>
  );
}
