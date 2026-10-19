# Notes for contributors and coding agents

The app is called **Cinemask** (raccoon mascot). The head logo is the app icon (`src/web/public/icon-*.png`, `docs/icon.png`); the couch scene is `docs/logo.png` and `src/web/public/hero.png`.

## Layout

- `src/server`: Fastify API (TypeScript, ESM, Node 22).
  - `app.ts` builds the app; `index.ts` starts it. Tests use `buildApp` directly.
  - `db/`: SQLite via better-sqlite3 + Drizzle ORM. `schema.ts` holds table definitions; `migrations.ts` holds the SQL. **Add a new migration for every schema change and never edit a released one.** `test/schema.test.ts` fails if the two drift.
  - `auth/`: sessions, the access guard, local login, OIDC and Plex sign-in.
  - `settings/`: every setting is defined in `definitions.ts` (zod schema + list of secret fields). Secrets are encrypted with `/config/secret.key`.
  - `backup/`: archive creation, retention, remote copies and restore.
  - `library/` and `integrations/`: Plex/Jellyfin sync, TMDB/mdblist metadata, availability statuses.
  - `arr/`: the download engine (release parser, quality profiles, indexers, download clients, search, tracker, importer, naming).
  - `files/`: rename, rescan and delete for monitored titles. **Every file operation goes through `insideRoot()`** so nothing outside the configured media folders can be touched.
  - `calendar/` and `health/`: the calendar feed and the Settings → Health checks.
  - `jobs/scheduler.ts`: all background jobs (backups, library sync, download tracking, RSS, health).
- `src/web`: React + Vite + TanStack Query + Tailwind v4. Theme colours are CSS variables in `styles.css`; new themes only redefine them.
- `test/`: Vitest. `helpers.ts` has a browser-like `Client` that keeps cookies and sends CSRF headers.

## Rules that keep the app secure

1. **Every `/api` route declares `config: { access }`** (`public`, `user`, `manager`, `admin` or `owner`). The app refuses to start otherwise, and `test/access.test.ts` calls every route as each level to prove the guard holds. Prefer the lowest level that works, and never `public` unless the route must work signed out.
2. **Validate all input with zod** via `parse()` from `lib/validate.ts`.
3. **Integration credentials go in settings as secret fields**, never in plain columns or logs.
4. **No SQL built from strings.** Use Drizzle or prepared statements.
5. **Write an audit entry** (`audit()`) for anything an admin would want to trace.
6. **The browser sends `x-requested-with: fetch` and `x-csrf-token`** on every write (see `src/web/lib/api.ts`). Don't add endpoints that change state on GET, except OAuth redirects.
7. Add a test for each new permission rule.

## Roles

- `user`: browse and request.
- `manager`: approve requests, download, manage files, posters and collections.
- `admin`: settings, integrations and users. Only the owner can manage other admins.
- The owner (`is_owner`) is the first admin. It can't be demoted, disabled or deleted, can always use password sign-in, and alone can download or restore backups.

## Roadmap

`docs/ROADMAP.md` lists the phases. Work through them in order; later phases assume earlier ones.
