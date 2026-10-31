import { LoadError } from '../components/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';

interface Operation {
  summary: string;
  description: string;
  tags: string[];
  'x-access': string;
  'x-api-key': boolean;
}
interface Spec {
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, Operation>>;
}

const METHOD_STYLE: Record<string, string> = { get: 'text-info', post: 'text-success', put: 'text-warning', patch: 'text-warning', delete: 'text-danger' };

/** A readable view of /api/openapi.json, which tools like Swagger or Postman can also import. */
export function ApiDocsPage() {
  const spec = useQuery({ queryKey: ['openapi'], queryFn: () => api<Spec>('/api/openapi.json') });
  const [filter, setFilter] = useState('');
  const [keysOnly, setKeysOnly] = useState(true);
  if (!spec.data) return <LoadError queries={[spec]} />;
  const f = filter.trim().toLowerCase();
  const ops = Object.entries(spec.data.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));
  const shown = ops.filter((o) => (!keysOnly || o.op['x-api-key']) && (!f || o.path.includes(f) || o.op.summary.toLowerCase().includes(f)));
  const groups = [...new Set(shown.map((o) => o.op.tags[0]!))].sort();
  const origin = window.location.origin;
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API reference</h1>
        <p className="text-sm text-muted">
          {spec.data.info.title} {spec.data.info.version}. {spec.data.info.description}
        </p>
      </div>
      <section className="card space-y-2 text-sm">
        <div className="font-medium">Example</div>
        <pre className="whitespace-pre-wrap break-all rounded bg-surface-2 p-3 text-xs">{`curl -H "X-Api-Key: cmk_..." ${origin}/api/stats`}</pre>
        <p className="text-muted">
          The machine-readable description is at{' '}
          <a href="/api/openapi.json" className="text-accent" target="_blank" rel="noreferrer">
            /api/openapi.json
          </a>{' '}
          for Postman, Insomnia or Swagger.
        </p>
      </section>
      <div className="flex flex-wrap items-center gap-4">
        <input className="input max-w-xs" placeholder="Filter endpoints" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={keysOnly} onChange={(e) => setKeysOnly(e.target.checked)} /> Only endpoints API keys can use
        </label>
      </div>
      {groups.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="font-semibold capitalize">{g.replace(/-/g, ' ')}</h2>
          <ul className="card divide-y divide-border p-0">
            {shown
              .filter((o) => o.op.tags[0] === g)
              .map((o) => (
                <li key={`${o.method} ${o.path}`} className="space-y-1 px-4 py-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`w-14 font-mono text-xs font-bold uppercase ${METHOD_STYLE[o.method] ?? ''}`}>{o.method}</span>
                    <code className="break-all">{o.path}</code>
                    <span className="ml-auto text-xs text-muted">{o.op['x-access']}</span>
                  </div>
                  {!o.op.summary.startsWith(o.method.toUpperCase()) && <div className="break-words text-muted sm:pl-16">{o.op.summary}</div>}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
