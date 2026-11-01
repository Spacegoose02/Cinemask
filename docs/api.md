# API

Everything the web app does goes through the same JSON API, so scripts can do it too.

- **Reference:** open **Account → API keys → API reference** in the app (the `/developer` page), or import `/api/openapi.json` into Postman, Insomnia or Swagger UI. The description is generated from the running server, so it always matches your version.
- **Base URL:** your Cinemask address, for example `https://media.example.com`.

## Authentication

Create a key under **Account → API keys** and send it in a header:

```bash
curl -H "X-Api-Key: cmk_..." https://media.example.com/api/stats
# or
curl -H "Authorization: Bearer cmk_..." https://media.example.com/api/stats
```

Keys are never accepted in the query string, since URLs end up in logs.

| Rule | Why |
|---|---|
| A key acts as its owner, with the owner's **current** role. | Demote or disable someone and their keys follow at once. |
| **Read-only** keys can only send `GET`. | Safe for dashboards. |
| Keys never reach account, session, key, settings, user or backup endpoints. Each endpoint's reference entry says whether keys can use it. | A leaked key can't take over the install. |
| Only a hash of each key is stored. A new key is shown once. | A database leak doesn't leak working keys. |
| Admins see and revoke every key in **Settings → API**, and can turn keys off entirely. | One switch stops all scripts. |

## Examples

Request a movie (a full-access key):

```bash
curl -X POST -H "X-Api-Key: cmk_..." -H "Content-Type: application/json" \
  -d '{"kind":"movie","tmdbId":116149}' https://media.example.com/api/requests
```

Approve every pending request (a manager's full-access key):

```bash
for id in $(curl -s -H "X-Api-Key: $KEY" "$URL/api/requests?status=pending" | jq '.[].id'); do
  curl -s -X POST -H "X-Api-Key: $KEY" -H "Content-Type: application/json" -d '{}' "$URL/api/requests/$id/approve"
done
```

What's coming out this week:

```bash
curl -H "X-Api-Key: $KEY" "$URL/api/calendar?start=$(date +%F)&end=$(date -d '+7 days' +%F)"
```

## Errors

Errors are JSON `{"error": "message"}` with the usual status codes: `400` invalid input, `401` missing or bad key, `403` not allowed for this user or key, `404` not found, `409` conflict (for example, already requested), `429` rate limited, `502` an outside service (TMDB, Plex…) failed.
