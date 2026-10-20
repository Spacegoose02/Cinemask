# Reverse proxy

Put Cinemask behind a reverse proxy to give it HTTPS and a name like `https://media.example.com`. In every case:

1. Set `TRUST_PROXY=true` on the container, so sign-in rate limits and the activity log see real client IPs. Leave it `false` when Cinemask is reachable directly, or anyone could fake their IP.
2. Set **Settings → General → Public URL** to the address people use.
3. Let the proxy handle HSTS. Cinemask sends its other security headers itself.

Cinemask needs no websockets and no special buffering. Allow uploads of at least 64 MB at the proxy: restoring a backup uploads the archive, which is usually a few megabytes but grows with your library.

## Nginx Proxy Manager

- **Details:** scheme `http`, forward hostname `cinemask` (or the server IP), port `7979`. Turn on **Block Common Exploits**.
- **SSL:** request a certificate, turn on **Force SSL** and **HTTP/2**.
- **Advanced:** `client_max_body_size 64m;`

## SWAG / nginx

`/config/nginx/proxy-confs/cinemask.subdomain.conf`:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name media.*;
    include /config/nginx/ssl.conf;
    client_max_body_size 64m;

    location / {
        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        set $upstream_app cinemask;
        set $upstream_port 7979;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }
}
```

## Caddy

```caddy
media.example.com {
    request_body {
        max_size 64MB
    }
    reverse_proxy cinemask:7979
}
```

## Traefik (labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.cinemask.rule=Host(`media.example.com`)
  - traefik.http.routers.cinemask.entrypoints=websecure
  - traefik.http.routers.cinemask.tls.certresolver=letsencrypt
  - traefik.http.services.cinemask.loadbalancer.server.port=7979
```

## Forward-auth proxies (tinyauth, Authelia, Authentik outpost)

Prefer the built-in [single sign-on](sso.md): Cinemask then knows who each person is and applies their role. If you also put forward auth in front, exclude these paths, or Home Assistant, scripts and Plex sign-in stop working:

- `/api/` requests that carry an `X-Api-Key` header (scripts, Home Assistant)
- `/api/auth/oidc/callback`
- `/manifest.webmanifest` and the icons, so phones can install the app

## Running under a path (`/cinemask`)

Not supported. Use a subdomain.
