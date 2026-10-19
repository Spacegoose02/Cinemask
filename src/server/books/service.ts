import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { absItems, books, downloads, type BookFormat } from '../db/schema.js';
import { placeFile } from '../arr/importer.js';
import { CATEGORIES, type Release } from '../arr/indexers.js';
import { grab, searchAll } from '../arr/search.js';
import { AudiobookshelfClient } from '../integrations/audiobookshelf.js';
import { OpenLibraryClient, type BookCard } from '../integrations/openlibrary.js';
import { ShelfmarkClient } from '../integrations/shelfmark.js';
import { insideRoot } from '../lib/paths.js';

export type BookRow = typeof books.$inferSelect;

export const AUDIO_EXT = ['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac'];
export const EBOOK_EXT = ['.epub', '.azw3', '.mobi', '.pdf', '.cbz', '.cbr', '.fb2'];
/** Plausible sizes, to skip fake or mislabelled releases. */
const SIZE = { audiobook: { min: 10 * 1024 * 1024, max: 8 * 1024 * 1024 * 1024 }, ebook: { min: 30 * 1024, max: 300 * 1024 * 1024 } };

export const openLibrary = (ctx: AppContext) => new OpenLibraryClient(() => ctx.db);

export function absClient(ctx: AppContext): AudiobookshelfClient | null {
  const s = ctx.settings.get('audiobookshelf');
  return s.enabled && s.url && s.apiKey ? new AudiobookshelfClient(s.url, s.apiKey) : null;
}

export function shelfmarkClient(ctx: AppContext): ShelfmarkClient | null {
  const s = ctx.settings.get('shelfmark');
  return s.enabled && s.url ? new ShelfmarkClient(s.url, s.username, s.password) : null;
}

/** Lowercase words without punctuation, articles or subtitles, for matching titles across sources. */
export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[:([].*$/, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

const words = (t: string) => normTitle(t).split(' ').filter((w) => w.length > 1 || /\d/.test(w));

/** A release or file name names this book: every title word is present, and the author's surname when known. */
export function namesBook(name: string, book: Pick<BookRow, 'title' | 'author'>): boolean {
  const hay = ` ${name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')} `;
  const title = words(book.title);
  if (!title.length || !title.every((w) => hay.includes(` ${w} `))) return false;
  const surname = book.author ? normTitle(book.author).split(' ').pop() : null;
  return !surname || hay.includes(` ${surname} `);
}

const looksAudio = (t: string) => /\b(m4b|mp3|aac|flac|audiobook|audio ?book|unabridged|narrated)\b/i.test(t);
const looksEbook = (t: string) => /\b(epub|azw3|mobi|pdf|ebook|e-book|kindle|retail)\b/i.test(t);

/** Ranks indexer releases for a book: right title and author, right format, sensible size; best first. */
export function rankReleases(releases: Release[], book: BookRow): Release[] {
  const size = SIZE[book.format];
  return releases
    .filter((r) => namesBook(r.title, book) && r.size >= size.min && r.size <= size.max)
    .filter((r) => (book.format === 'audiobook' ? !looksEbook(r.title) || looksAudio(r.title) : !looksAudio(r.title)))
    .map((r) => {
      let score = 0;
      if (book.format === 'audiobook' && /\bm4b\b/i.test(r.title)) score += 30;
      if (book.format === 'ebook' && /\bepub\b/i.test(r.title)) score += 30;
      if (/\babridged\b/i.test(r.title) && !/\bunabridged\b/i.test(r.title)) score -= 50;
      if (r.protocol === 'torrent') score += Math.min(20, r.seeders ?? 0);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

export function getBook(ctx: AppContext, id: number): BookRow | undefined {
  return ctx.db.select().from(books).where(eq(books.id, id)).get();
}

const setBook = (ctx: AppContext, id: number, values: Partial<BookRow>) => ctx.db.update(books).set(values).where(eq(books.id, id)).run();

/**
 * Starts downloading an approved book: through Shelfmark when it handles this format, otherwise
 * from the indexers. Leaves the book "downloading", or "failed" with the reason.
 */
export async function startBookDownload(ctx: AppContext, id: number, userId: number | null = null): Promise<BookRow> {
  const book = getBook(ctx, id);
  if (!book) throw new Error('Book not found');
  const errors: string[] = [];
  const sm = shelfmarkClient(ctx);
  const smFor = ctx.settings.get('shelfmark').useFor;
  if (sm && (book.format === 'ebook' || smFor === 'both')) {
    try {
      const results = await sm.search(`${book.title} ${book.author ?? ''}`.trim(), book.format === 'audiobook' ? 'audiobook' : undefined);
      const pick = results.find((r) => namesBook(`${r.title} ${r.author ?? ''}`, book));
      if (pick) {
        await sm.download(pick.id);
        setBook(ctx, id, { status: 'downloading', externalId: `shelfmark:${pick.id}`, error: null });
        return getBook(ctx, id)!;
      }
      errors.push('Shelfmark found no match');
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  try {
    const { releases, errors: idxErrors } = await searchAll(ctx, {
      type: 'search',
      q: `${book.author ? `${normTitle(book.author).split(' ').pop()} ` : ''}${normTitle(book.title)}`,
      categories: book.format === 'audiobook' ? CATEGORIES.audiobooks : CATEGORIES.books,
    });
    errors.push(...idxErrors);
    const best = rankReleases(releases, book)[0];
    if (best) {
      const dlId = await grab(ctx, best, null, { userId, quality: book.format });
      ctx.db.update(downloads).set({ bookId: id }).where(eq(downloads.id, dlId)).run();
      setBook(ctx, id, { status: 'downloading', externalId: `download:${dlId}`, error: null });
      return getBook(ctx, id)!;
    }
    errors.push('No matching release on your indexers');
  } catch (err) {
    errors.push((err as Error).message);
  }
  setBook(ctx, id, { status: 'failed', error: [...new Set(errors)].join('; ').slice(0, 500) });
  return getBook(ctx, id)!;
}

/** Files of the book's format under a path (a file or folder), never following links. */
export function findBookFiles(p: string, format: BookFormat): string[] {
  const exts = format === 'audiobook' ? AUDIO_EXT : EBOOK_EXT;
  if (!fs.existsSync(p)) return [];
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return [];
  if (st.isFile()) return exts.includes(path.extname(p).toLowerCase()) ? [p] : [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(p, 0);
  return out.sort();
}

const clean = (s: string) =>
  s
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);

/** Audiobookshelf's preferred layout: Author/Title (Year)/files. */
export function bookFolder(ctx: AppContext, book: BookRow): { root: string; dir: string } {
  const m = ctx.settings.get('media');
  const root = book.format === 'audiobook' ? m.audiobooksPath : m.booksPath;
  const title = clean(`${book.title}${book.year ? ` (${book.year})` : ''}`) || 'Untitled';
  return { root, dir: path.join(root, clean(book.author ?? '') || 'Unknown Author', title) };
}

/**
 * Copies a finished book into the audiobook or book folder, keeping file names (track order).
 * For ebooks only the best file is kept (EPUB first). Every destination is checked against the root.
 */
export function importBook(ctx: AppContext, id: number, sourcePath: string): string[] {
  const book = getBook(ctx, id);
  if (!book) throw new Error('Book not found');
  let files = findBookFiles(sourcePath, book.format);
  if (!files.length) throw new Error(`No ${book.format === 'audiobook' ? 'audio' : 'ebook'} files in the download`);
  if (book.format === 'ebook') files = [files.sort((a, b) => EBOOK_EXT.indexOf(path.extname(a).toLowerCase()) - EBOOK_EXT.indexOf(path.extname(b).toLowerCase()))[0]!];
  const { root, dir } = bookFolder(ctx, book);
  const base = fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath);
  const mode = ctx.settings.get('media').importMode;
  const placed: string[] = [];
  for (const f of files) {
    const rel = book.format === 'ebook' ? `${clean(book.title) || 'book'}${path.extname(f).toLowerCase()}` : path.relative(base, f).split(path.sep).map(clean).join(path.sep);
    const dest = path.join(dir, rel);
    if (!insideRoot(root, dest)) throw new Error('Refusing to write outside the book folder');
    placeFile(f, dest, mode);
    placed.push(dest);
  }
  setBook(ctx, id, { status: 'available', path: dir, error: null });
  const abs = absClient(ctx);
  const libId = ctx.settings.get('audiobookshelf').audiobookLibraryId;
  if (abs && libId && book.format === 'audiobook') void abs.scan(libId).catch(() => undefined);
  return placed;
}

/** Marks a book download failed (called by the tracker). */
export function failBook(ctx: AppContext, id: number, reason: string) {
  setBook(ctx, id, { status: 'failed', error: reason.slice(0, 500) });
}

/** Checks Shelfmark's queue and imports books it has finished from its download folder. */
export async function pollShelfmark(ctx: AppContext): Promise<void> {
  const active = ctx.db.select().from(books).where(eq(books.status, 'downloading')).all().filter((b) => b.externalId?.startsWith('shelfmark:'));
  if (!active.length) return;
  const sm = shelfmarkClient(ctx);
  if (!sm) return;
  const status = await sm.status();
  const ingest = ctx.settings.get('shelfmark').ingestPath;
  for (const b of active) {
    const state = ShelfmarkClient.stateOf(status, b.externalId!.slice(10));
    if (state === 'error') failBook(ctx, b.id, 'Shelfmark could not download it');
    if (state !== 'done' && state !== 'available') continue;
    const file = findBookFiles(ingest, b.format).find((f) => namesBook(path.basename(f), b));
    if (!file) {
      // Shelfmark finished but delivered elsewhere (for example straight to Calibre-Web): treat as done.
      setBook(ctx, b.id, { status: 'available', error: null });
      continue;
    }
    try {
      importBook(ctx, b.id, file);
    } catch (err) {
      failBook(ctx, b.id, (err as Error).message);
    }
  }
}

/** Mirrors what's in Audiobookshelf, then marks requested audiobooks that showed up there as available. */
export async function syncAudiobookshelf(ctx: AppContext): Promise<{ books: number; podcasts: number }> {
  const abs = absClient(ctx);
  if (!abs) throw new Error('Audiobookshelf is not connected');
  const s = ctx.settings.get('audiobookshelf');
  const libs = (await abs.libraries()).filter((l) => [s.audiobookLibraryId, s.podcastLibraryId].includes(l.id) || (!s.audiobookLibraryId && !s.podcastLibraryId));
  const seen: string[] = [];
  const counts = { books: 0, podcasts: 0 };
  for (const lib of libs) {
    for (const it of await abs.items(lib.id)) {
      const md = it.media.metadata;
      const values = {
        libraryId: lib.id,
        mediaType: it.mediaType === 'podcast' ? ('podcast' as const) : ('book' as const),
        title: md.title ?? 'Untitled',
        author: md.authorName ?? md.author ?? null,
        asin: md.asin ?? null,
        isbn: md.isbn ?? null,
        addedAt: it.addedAt ?? null,
      };
      ctx.db.insert(absItems).values({ absId: it.id, ...values }).onConflictDoUpdate({ target: absItems.absId, set: values }).run();
      seen.push(it.id);
      counts[values.mediaType === 'podcast' ? 'podcasts' : 'books']++;
    }
  }
  if (seen.length) ctx.db.delete(absItems).where(notInArray(absItems.absId, seen)).run();
  else ctx.db.delete(absItems).run();
  const waiting = ctx.db.select().from(books).where(and(eq(books.format, 'audiobook'), inArray(books.status, ['approved', 'downloading', 'failed']))).all();
  for (const b of waiting) if (absMatch(ctx, b)) setBook(ctx, b.id, { status: 'available', error: null });
  return counts;
}

/** The Audiobookshelf item for a book, matched by ISBN or by title and author. */
export function absMatch(ctx: AppContext, b: Pick<BookRow, 'title' | 'author' | 'isbn'>) {
  const items = ctx.db.select().from(absItems).where(eq(absItems.mediaType, 'book')).all();
  const t = normTitle(b.title);
  const surname = b.author ? normTitle(b.author).split(' ').pop() : null;
  return items.find((i) => (b.isbn && i.isbn === b.isbn) || (normTitle(i.title) === t && (!surname || !i.author || normTitle(i.author).includes(surname))));
}

/** Search results annotated with request state per format and whether ABS already has it. */
export function annotate(ctx: AppContext, cards: BookCard[]) {
  const keys = cards.map((c) => c.workKey);
  const rows = keys.length ? ctx.db.select().from(books).where(inArray(books.workKey, keys)).orderBy(desc(books.createdAt)).all() : [];
  return cards.map((c) => ({
    ...c,
    inAudiobookshelf: Boolean(absMatch(ctx, c)),
    requests: Object.fromEntries(rows.filter((r) => r.workKey === c.workKey).map((r) => [r.format, { id: r.id, status: r.status }])) as Partial<Record<BookFormat, { id: number; status: string }>>,
  }));
}
