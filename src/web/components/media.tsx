import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  cardPath,
  poster,
  STATUS_LABEL,
  type Availability,
  type MediaCardData,
} from "../lib/media";
import { api, hasRole } from "../lib/api";
import { useAuth } from "../lib/auth";
import { t } from "../lib/i18n";
import { ChooseFolder, useRootFolders, type RootFolder } from "./MediaActions";

const STATUS_STYLE: Record<Availability, string> = {
  on_server: "bg-success text-bg",
  partial: "bg-accent text-accent-fg",
  not_on_server: "bg-surface-2 text-muted border border-border",
  not_available: "bg-surface-2 text-muted border border-border",
};

export function StatusBadge({
  status,
  resolution,
}: {
  status: Availability;
  resolution?: string | null;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
      {resolution && <span className="opacity-80">· {resolution}</span>}
    </span>
  );
}

/** Titles with a waiting or approved request, shared by every card on the page. */
function useOpenRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["requests-open"],
    queryFn: () => api<{ titles: string[] }>("/api/requests/open"),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Request straight from a poster, for titles that aren't on the server. A movie or a whole show is
 * asked for in one tap; the server applies the usual approval, limits, streaming rule and "me too".
 * A manager with several library folders picks one first, as on the title page.
 */
function CardRequestButton({
  item,
}: {
  item: MediaCardData & { tmdbId: number };
}) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, "manager");
  const open = useOpenRequests(Boolean(me));
  const roots = useRootFolders(isManager);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState<RootFolder[] | null>(null);
  if (!me) return null;
  const requested =
    state === "done" ||
    open.data?.titles.includes(`${item.kind}:${item.tmdbId}`);
  const label = isManager ? t("Download") : t("Request");

  const onClick = async (e: MouseEvent) => {
    // The card is a link to the title page; the button shouldn't open it.
    e.preventDefault();
    e.stopPropagation();
    if (requested || state === "busy") return;
    if (isManager) {
      // Wait for the folder list rather than guess: with several, the manager picks one.
      const list =
        (roots.data ?? (await roots.refetch()).data)?.roots.filter(
          (r) => r.kind === item.kind,
        ) ?? [];
      if (list.length > 1) return setChoosing(list);
    }
    await send();
  };

  const send = async (rootId?: string) => {
    setState("busy");
    setError("");
    try {
      await api("/api/requests", {
        body: {
          kind: item.kind,
          tmdbId: item.tmdbId,
          ...(rootId ? { rootId } : {}),
        },
      });
      setState("done");
      await qc.invalidateQueries({ queryKey: ["requests-open"] });
      await qc.invalidateQueries({ queryKey: ["request-quota"] });
    } catch (err) {
      setState("error");
      setError((err as Error).message);
    }
  };

  const base =
    "absolute bottom-1 right-1 rounded px-1.5 py-0.5 text-[11px] font-medium shadow";
  if (requested)
    return (
      <span
        className={`${base} bg-accent text-accent-fg`}
        onClick={(e) => (e.preventDefault(), e.stopPropagation())}
      >
        ✓ {t(isManager ? "Added" : "Requested")}
      </span>
    );
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={state === "busy"}
        title={
          state === "error"
            ? error
            : t("{action} {title}", { action: label, title: item.title })
        }
        aria-label={t("{action} {title}", { action: label, title: item.title })}
        className={`${base} ${state === "error" ? "bg-danger text-bg" : "bg-accent text-accent-fg"} transition hover:brightness-110`}
      >
        {state === "busy"
          ? "…"
          : state === "error"
            ? `! ${t("Try again")}`
            : `+ ${label}`}
      </button>
      {choosing &&
        // Outside the card's link, so picking a folder doesn't open the title page.
        createPortal(
          <div onClick={(e) => e.stopPropagation()}>
            <ChooseFolder
              title={item.title}
              action={t("Download")}
              roots={choosing}
              onClose={() => setChoosing(null)}
              onChosen={(root) => {
                setChoosing(null);
                void send(root);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

export function MediaCard({
  item,
  extra,
}: {
  item: MediaCardData;
  extra?: ReactNode;
}) {
  const img = poster(item.posterPath);
  const status = item.availability?.status ?? "on_server";
  const body = (
    <div className="group">
      <div className="relative aspect-[2/3] overflow-hidden rounded-md border border-border bg-surface-2">
        {img ? (
          <img
            src={img}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">
            {item.title}
          </div>
        )}
        <div className="absolute left-1 top-1">
          <StatusBadge
            status={status}
            resolution={item.availability?.resolution ?? item.resolution}
          />
        </div>
        {item.viewCount ? (
          <span
            className="absolute bottom-1 right-1 rounded bg-success px-1.5 py-0.5 text-[11px] font-medium text-bg"
            title={`Watched ${item.viewCount} ${item.viewCount === 1 ? "time" : "times"}`}
          >
            ✓ Watched
          </span>
        ) : null}
        {item.tmdbId &&
        item.availability &&
        (status === "not_on_server" || status === "not_available") ? (
          <CardRequestButton item={{ ...item, tmdbId: item.tmdbId }} />
        ) : null}
      </div>
      <div className="mt-1.5 truncate text-sm">{item.title}</div>
      <div className="text-xs text-muted">
        {item.year ?? ""} · {item.kind === "movie" ? "Movie" : "Series"}
      </div>
    </div>
  );
  const to = cardPath(item);
  const card = to ? <Link to={to}>{body}</Link> : body;
  return extra ? (
    <div>
      {card}
      {extra}
    </div>
  ) : (
    card
  );
}

export function MediaGrid<T extends MediaCardData>({
  items,
  extra,
}: {
  items: T[];
  extra?: (item: T) => ReactNode;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-4">
      {items.map((i, n) => (
        <MediaCard
          key={`${i.kind}-${i.tmdbId ?? n}-${n}`}
          item={i}
          extra={extra?.(i)}
        />
      ))}
    </div>
  );
}

export function MediaRow({
  title,
  items,
  more,
}: {
  title: string;
  items: MediaCardData[];
  more?: string;
}) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        {more && (
          <Link to={more} className="text-sm text-muted hover:text-accent">
            {t("See all")}
          </Link>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((i, n) => (
          <div
            key={`${i.kind}-${i.tmdbId ?? n}-${n}`}
            className="w-32 shrink-0 sm:w-36"
          >
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
  return site === "Vimeo"
    ? `https://player.vimeo.com/video/${encodeURIComponent(key)}${autoplay ? "?autoplay=1" : ""}`
    : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}${autoplay ? "?autoplay=1" : ""}`;
}

/** Plays a trailer: a file on the server (src), or a YouTube/Vimeo video. */
export function TrailerModal({
  videoKey,
  site = "YouTube",
  src,
  onClose,
}: {
  videoKey?: string;
  site?: string;
  src?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="aspect-video w-full max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        {src ? (
          <video
            className="h-full w-full rounded-lg bg-black"
            src={src}
            controls
            autoPlay
            title={t("Trailer")}
          />
        ) : (
          <iframe
            className="h-full w-full rounded-lg"
            src={embedUrl(site, videoKey ?? "", true)}
            title={t("Trailer")}
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}
