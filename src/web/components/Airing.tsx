import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { mediaPath, poster } from '../lib/media';

export interface AiringEpisode {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  season: number;
  episode: number;
  episodeTitle: string | null;
  airDate: string;
  hasFile: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "Tonight", "Tomorrow", "Yesterday", a weekday within a week, else "Jan 20" (with the year when it isn't this year). */
export function airDayLabel(date: string, now = new Date()): string {
  const day = (offset: number) => localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  if (date === day(0)) return 'Tonight';
  if (date === day(1)) return 'Tomorrow';
  if (date === day(-1)) return 'Yesterday';
  const d = new Date(`${date}T12:00:00`);
  if (date > day(1) && date < day(7)) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (date < day(-1) && date > day(-7)) return `Last ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}

export const episodeCode = (e: { season: number; episode: number }) => `S${pad(e.season)}E${pad(e.episode)}`;

export function useAiring(days = 7) {
  return useQuery({ queryKey: ['airing', days], queryFn: () => api<{ next: AiringEpisode[]; recent: AiringEpisode[] }>(`/api/airing?days=${days}`) });
}

function AiringCard({ e }: { e: AiringEpisode }) {
  const img = poster(e.posterPath);
  return (
    <Link to={mediaPath('show', e.tmdbId)} className="group block" title={e.episodeTitle ?? undefined}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-md border border-border bg-surface-2">
        {img ? <img src={img} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" /> : <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{e.title}</div>}
        <span className="absolute left-1 top-1 rounded bg-bg/85 px-1.5 py-0.5 text-[11px] font-medium">{airDayLabel(e.airDate)}</span>
        {e.hasFile && <span className="absolute bottom-1 right-1 rounded bg-success px-1.5 py-0.5 text-[11px] font-medium text-bg">✓ Downloaded</span>}
      </div>
      <div className="mt-1.5 truncate text-sm">{e.title}</div>
      <div className="truncate text-xs text-muted">
        {episodeCode(e)}
        {e.episodeTitle ? ` · ${e.episodeTitle}` : ''}
      </div>
    </Link>
  );
}

/** A row of shows by their next (or latest) episode. Hidden when there's nothing to show. */
export function AiringRow({ title, items, more }: { title: string; items: AiringEpisode[]; more?: string }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        {more && (
          <Link to={more} className="text-sm text-muted hover:text-accent">
            See all
          </Link>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((e) => (
          <div key={`${e.tmdbId}-${e.season}-${e.episode}`} className="w-32 shrink-0 sm:w-36">
            <AiringCard e={e} />
          </div>
        ))}
      </div>
    </section>
  );
}
