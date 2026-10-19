import { useQuery } from '@tanstack/react-query';
import { MediaRow } from '../components/media';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaCardData } from '../lib/media';

export function HomePage() {
  const { me } = useAuth();
  const recent = useQuery({ queryKey: ['recent'], queryFn: () => api<{ items: MediaCardData[] }>('/api/library/recent') });
  const trending = useQuery({ queryKey: ['trending'], queryFn: () => api<{ results: MediaCardData[] }>('/api/discover/trending') });
  const empty = recent.data?.items.length === 0 && trending.data?.results.length === 0;
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Hi {me?.displayName || me?.username}</h1>
      <MediaRow title="Recently added" items={recent.data?.items ?? []} more="/library" />
      <MediaRow title="Trending this week" items={trending.data?.results ?? []} />
      {empty && <div className="card text-sm text-muted">Nothing to show yet. An admin can connect Plex or Jellyfin and add a TMDB key in Settings.</div>}
    </div>
  );
}
