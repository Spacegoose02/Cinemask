# Security

## Reporting a problem

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.

## Security model

- **Accounts:** passwords are hashed with Argon2id (OWASP parameters), must be at least 12 characters and can't contain the username. Five failed attempts lock an account for 15 minutes, and sign-in endpoints are rate limited per IP. Unknown usernames and wrong passwords get the same response and similar timing.
- **Sessions:** random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). Only a SHA-256 hash is stored. Changing a password, role or account status signs the user out elsewhere.
- **CSRF:** every state-changing request needs a custom header (which other sites can't send without CORS approval, and none is granted) and a per-session CSRF token.
- **Authorization:** deny by default. Every API route declares the minimum role, checked server-side on every request against the current database role.
- **Single sign-on:** OIDC uses PKCE, state and nonce, and the state is bound to the browser that started the flow. SSO identities are matched only by the provider's stable subject id, never by email. Plex sign-in only admits Plex accounts that can access the configured server.
- **API keys:** 240-bit random keys, stored only as HMAC-SHA256 hashes keyed with the instance key and shown once. A key acts as its owner with their current role, read-only keys can only `GET`, and keys are refused on account, session, key, settings, user and backup endpoints (`test/api.test.ts` checks every route). Keys are read only from headers, never the query string. Because browsers never send them on their own, key requests skip the CSRF check; a hostile web page can't add the header without a CORS approval the server never gives. Admins can list and revoke every key, or turn keys off.
- **Outbound requests:** URLs people supply (poster links, direct downloads) must be public `https` or `http` addresses; private and loopback addresses are refused unless an admin allows them, and redirects are re-checked. List imports only fetch mdblist and TMDB. Podcast feeds are looked up server-side by Apple id. Integration and webhook URLs are set by admins only.
- **Files:** every file the app writes, moves or deletes (imports, renames, deletes, trailers, books) is checked to be inside the configured media folder after resolving symlinks, and download folders are walked without following links. yt-dlp runs without a shell, with a validated video id.
- **Webhooks:** the webhook URL is stored encrypted (the id in it is the credential), events carry titles and ids only, and redirects are refused.
- **Secrets:** integration credentials are encrypted with AES-256-GCM using a per-install key in `/config/secret.key` and are never returned by the API.
- **Backups:** include the database and the instance key, are created with mode 0600, can be encrypted with a passphrase (scrypt + AES-256-GCM), and are checked for integrity before restore. Only the owner can download or restore them.
- **Headers:** strict Content Security Policy, `frame-ancestors 'none'`, `nosniff` and related headers via Helmet. HSTS is left to your reverse proxy.
- **Container:** runs as `PUID:PGID` with no capabilities, not as root. `/config` is mode 0700 and keys and backups are 0600; imported media uses `UMASK` (default 002) so media servers can read it.
- **Supply chain:** CI runs tests, lint, type checks, `npm audit`, CodeQL and Dependabot.

## Hardening tips

- Put the app behind a reverse proxy with HTTPS, and set `TRUST_PROXY=true`.
- Set a backup passphrase before enabling remote backups.
- Prefer single sign-on with MFA at your identity provider.
- Give Home Assistant and dashboards read-only API keys, and set an expiry on keys for one-off scripts.
