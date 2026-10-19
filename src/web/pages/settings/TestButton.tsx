import { useState } from 'react';
import { Alert } from '../../components/ui';
import { api } from '../../lib/api';

/** Runs a saved-settings connection test. Save first, since tests use stored values. */
export function TestButton({ service, beforeTest }: { service: string; beforeTest?: () => Promise<void> }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          try {
            await beforeTest?.();
            setResult(await api<{ ok: boolean; message: string }>(`/api/integrations/${service}/test`, { method: 'POST' }));
          } catch (e) {
            setResult({ ok: false, message: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Testing…' : 'Save and test'}
      </button>
      {result && <Alert kind={result.ok ? 'success' : 'error'}>{result.message}</Alert>}
    </div>
  );
}
