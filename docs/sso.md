# Single sign-on

Cinemask signs people in with any OpenID Connect provider. It uses the authorization code flow with PKCE, and matches people by the provider's stable subject id, never by email.

## Steps for every provider

1. **Settings → General**: set the public URL, for example `https://media.example.com`.
2. In the provider, create a **confidential** client (also called an application) with:
   - Redirect URL: `https://media.example.com/api/auth/oidc/callback`
   - Scopes: `openid profile email groups` (leave out `groups` if the provider has no groups)
3. **Settings → Sign-in → Single sign-on (OIDC)**: tick **Enable single sign-on** and paste the issuer URL, client ID and client secret.
4. Optionally:
   - fill **Admin groups** and **Manager groups** (everyone else is a User);
   - fill **Allowed groups**, so only those people can sign in;
   - untick **Create accounts on first sign-in** if you'd rather create users yourself and let people link their SSO account from **Account**.

New SSO accounts start as User or Manager, never Admin, unless they're in an admin group. The owner can always sign in with a password, so a broken SSO setup can't lock you out.

## tinyauth

tinyauth is usually run as forward auth in front of apps. If your tinyauth version can also act as an OpenID Connect provider, create a client with the redirect URL above and use tinyauth's address as the issuer. Otherwise keep tinyauth as forward auth (see [reverse-proxy.md](reverse-proxy.md) for the paths to exclude) and let people sign in to Cinemask with their own accounts or Plex.

## Authelia

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: cinemask
        client_name: Cinemask
        client_secret: '$pbkdf2-sha512$...'   # authelia crypto hash generate pbkdf2
        public: false
        authorization_policy: two_factor
        require_pkce: true
        pkce_challenge_method: S256
        redirect_uris:
          - https://media.example.com/api/auth/oidc/callback
        scopes: [openid, profile, email, groups]
        token_endpoint_auth_method: client_secret_basic
```

Issuer: `https://auth.example.com`. Groups claim: `groups`.

## Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider**. Client type **Confidential**, redirect URI as above, signing key set.
2. **Applications → Create**, slug `cinemask`, using that provider.
3. Issuer: `https://authentik.example.com/application/o/cinemask/`. Groups claim: `groups`.

## Pocket ID

Create an OIDC client with the callback URL above and turn on PKCE. Issuer: your Pocket ID address. Groups claim: `groups`.

## Keycloak

Create a client with **Client authentication** on and the redirect URI above. Add a **Group Membership** mapper with token claim name `groups` and **Full group path** off. Issuer: `https://keycloak.example.com/realms/<realm>`.

## Sign in with Plex

**Settings → Media servers**: connect Plex and test it, which records your server's id. **Settings → Sign-in**: tick **Enable Plex sign-in**. Only Plex accounts that can access your server can sign in.

## Troubleshooting

| Message on the sign-in page | Fix |
|---|---|
| Single sign-on is not set up. | Tick Enable single sign-on in Settings → Sign-in and save the issuer, client ID and secret. |
| An admin needs to set the public URL… | Settings → General → Public URL. |
| Could not reach the sign-on provider. | The container can't reach the issuer URL. Check DNS, and that the issuer serves `/.well-known/openid-configuration`. |
| Your account is not in a group allowed to use this app. | Add the person to one of the Allowed, Manager or Admin groups at the provider. |
