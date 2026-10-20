import { fetchJson } from "./http.js";

export interface RmabBook {
  asin: string;
  title: string;
  author: string;
  narrator?: string;
  description?: string;
  coverArtUrl?: string;
}

export interface RmabRequest {
  id: string;
  status: string;
  progress?: number;
  errorMessage?: string | null;
}

/** What a ReadMeABook request status means here. */
export type RmabState = "active" | "done" | "failed";

const DONE = ["downloaded", "available", "completed"];
const FAILED = ["failed", "denied", "cancelled"];

/**
 * ReadMeABook (audiobook requests and automation) over its API-token endpoints: search Audible
 * metadata, create a request, and read a request's status. ReadMeABook then finds, downloads and
 * imports the audiobook into Audiobookshelf or Plex itself.
 */
export class ReadMeABookClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return fetchJson<T>(
      "ReadMeABook",
      `${this.url.replace(/\/+$/, "")}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      },
      30_000,
    );
  }

  async test(): Promise<string> {
    const me = await this.call<{
      user?: { username?: string };
      username?: string;
    }>("/api/auth/me");
    const name = me.user?.username ?? me.username;
    return name ? `Connected as ${name}` : "Connected";
  }

  async search(query: string): Promise<RmabBook[]> {
    const r = await this.call<{ results?: RmabBook[] }>(
      `/api/audiobooks/search?${new URLSearchParams({ q: query }).toString()}`,
    );
    return (r.results ?? []).filter((b) => b.asin && b.title);
  }

  /** Creates a request; one that already exists (or is already in the library) counts as made. */
  async request(
    book: RmabBook,
  ): Promise<{ id: string | null; already: boolean }> {
    const body = JSON.stringify({
      audiobook: {
        asin: book.asin,
        title: book.title,
        author: book.author,
        narrator: book.narrator,
        description: book.description,
        coverArtUrl: book.coverArtUrl,
      },
    });
    try {
      const r = await this.call<{ request?: { id?: string } }>(
        "/api/requests",
        { method: "POST", body },
      );
      return { id: r.request?.id ?? null, already: false };
    } catch (err) {
      // 409-style answers ("AlreadyAvailable", "DuplicateRequest", "BeingProcessed") come back as HTTP errors.
      if (/HTTP 409/.test((err as Error).message))
        return { id: null, already: true };
      throw err;
    }
  }

  async status(id: string): Promise<RmabRequest> {
    const r = await this.call<{ request?: RmabRequest } & Partial<RmabRequest>>(
      `/api/requests/${encodeURIComponent(id)}`,
    );
    return r.request ?? (r as RmabRequest);
  }

  static stateOf(status: string): RmabState {
    if (DONE.includes(status)) return "done";
    if (FAILED.includes(status)) return "failed";
    return "active";
  }
}
