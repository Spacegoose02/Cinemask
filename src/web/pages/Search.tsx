import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { MediaGrid } from '../components/media';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import type { MediaCardData } from '../lib/media';
import { useT } from '../lib/i18n';

interface SearchResponse {
  library: MediaCardData[];
  results: MediaCardData[];
  totalPages: number;
  error: string | null;
}

export function SearchPage() {
  const [params] = useSearchParams();
  const t = useT();
  const q = params.get('q') ?? '';
  const res = useQuery({ queryKey: ['search', q], queryFn: () => api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`), enabled: Boolean(q) });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('Results for “{q}”', { q })}</h1>
      {res.data?.error && <Alert>{res.data.error}</Alert>}
      {res.data && res.data.library.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t('In your library')}</h2>
          <MediaGrid items={res.data.library} />
        </section>
      )}
      {res.data && res.data.results.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t('Movies and shows')}</h2>
          <MediaGrid items={res.data.results} />
        </section>
      )}
      {res.data && !res.data.library.length && !res.data.results.length && <p className="text-muted">{t('No matches.')}</p>}
    </div>
  );
}
