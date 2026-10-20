import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { mediaPath, poster, STATUS_LABEL, type Availability, type MediaCardData } from '../lib/media';

const STATUS_STYLE: Record<Availability, string> = {
  on_server: 'bg-success text-bg',
  partial: 'bg-accent text-accent-fg',
  not_on_server: 'bg-surface-2 text-muted border border-border',
  not_available: 'bg-surface-2 text-muted border border-border',
};

export function StatusBadge({ status, resolution }: { status: Availability; resolution?: string | null }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
      {resolution && <span className="opacity-80">· {resolution}</span>}
    </span>
  );
}

export function MediaCard({ item, extra }: { item: MediaCardData; extra?: ReactNode }) {
  const img = poster(item.posterPath);
  const status = item.availability?.status ?? 'on_server';
  const body = (
    <div className="group">
      <div className="relative aspect-[2/3] overflow-hidden rounded-md border border-border bg-surface-2">
        {img ? (
          <img src={img} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{item.title}</div>
        )}
        <div className="absolute left-1 top-1">
          <StatusBadge status={status} resolution={item.availability?.resolution ?? item.resolution} />
        </div>
        {item.viewCount ? (
          <span className="absolute bottom-1 right-1 rounded bg-success px-1.5 py-0.5 text-[11px] font-medium text-bg" title={`Watched ${item.viewCount} ${item.viewCount === 1 ? 'time' : 'times'}`}>
            ✓ Watched
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 truncate text-sm">{item.title}</div>
      <div className="text-xs text-muted">
        {item.year ?? ''} · {item.kind === 'movie' ? 'Movie' : 'Series'}
      </div>
    </div>
  );
  const card = item.tmdbId ? <Link to={mediaPath(item.kind, item.tmdbId)}>{body}</Link> : body;
  return extra ? (
    <div>
      {card}
      {extra}
    </div>
  ) : (
    card
  );
}

export function MediaGrid<T extends MediaCardData>({ items, extra }: { items: T[]; extra?: (item: T) => ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-4">
      {items.map((i, n) => (
        <MediaCard key={`${i.kind}-${i.tmdbId ?? n}-${n}`} item={i} extra={extra?.(i)} />
      ))}
    </div>
  );
}

export function MediaRow({ title, items, more }: { title: string; items: MediaCardData[]; more?: string }) {
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
        {items.map((i, n) => (
          <div key={`${i.kind}-${i.tmdbId ?? n}-${n}`} className="w-32 shrink-0 sm:w-36">
            <MediaCard item={i} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** YouTube trailer in a privacy-enhanced (no-cookie) embed. */
/** Embed address for a YouTube or Vimeo video. */
export function embedUrl(site: string, key: string, autoplay = false): string {
  return site === 'Vimeo'
    ? `https://player.vimeo.com/video/${encodeURIComponent(key)}${autoplay ? '?autoplay=1' : ''}`
    : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}${autoplay ? '?autoplay=1' : ''}`;
}

/** Plays a trailer: a file on the server (src), or a YouTube/Vimeo video. */
export function TrailerModal({ videoKey, site = 'YouTube', src, onClose }: { videoKey?: string; site?: string; src?: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="aspect-video w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        {src ? (
          <video className="h-full w-full rounded-lg bg-black" src={src} controls autoPlay title="Trailer" />
        ) : (
          <iframe
            className="h-full w-full rounded-lg"
            src={embedUrl(site, videoKey ?? '', true)}
            title="Trailer"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}
