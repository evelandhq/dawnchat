# Authentication and identity

Dawn keeps application identity, Agent authorization, and local browser
ownership separate. A credential is forwarded only to the boundary it was
issued for.

## Access modes

On every full app load, the identity gate checks Eveland:

- When Eveland offers provider login, the user must establish an Eveland
  Identity Session before using the app.
- When Eveland explicitly reports an open-access configuration, the gate steps
  aside and the signed Dawn browser session owns anonymous history.
- Configuration and availability failures are shown as errors with an explicit
  retry instead of redirecting the browser to a refusal response.

## Credentials

| Credential | Purpose | Forwarded to an Agent? |
| --- | --- | --- |
| Eveland Identity cookie | Browser login and Realm selection | No |
| Dawn's legacy `eve_chats_session` cookie | Anonymous browser ownership and legacy-chat claiming | No |
| Eveland App Token | Identity-scoped Dawn history and mutations | No |
| Eveland Caller Token | One Project's Agent after a valid challenge | Yes, only to its signed Catalog URL |
| External Agent bearer/header secret | Authentication configured for one external Agent | Yes, only to that Agent |

App and Caller Tokens are cached only in browser memory and refreshed before
expiry. Dawn verifies their signatures against Eveland JWKS. A Caller Token
contains its Project and signed `agent_url`; the proxy checks both before
forwarding it, so browser-supplied metadata cannot redirect the credential.
Catalog membership alone never causes a Caller Token to be sent. The Agent must
return a valid Eveland authentication challenge for its exact Project.

The signed, HttpOnly Dawn browser cookie remains in use even on authenticated
deployments. On the first authenticated load, `POST /api/chats/claim`
idempotently adopts that browser's identity-less chats into the active
`(issuer, principal, Realm)` scope. It never re-owns a chat that already belongs
to an identity.

## Same-origin Identity requests

When Eveland Identity and Dawn use the same hostname on different ports,
cookie-bearing `/api/identity/*` requests go through the app's same-origin Next.js
rewrite. Top-level provider login and Agent-provided continuation navigation go
directly to Eveland's public frontdoor.

Production should place Eveland Identity and Dawn on one HTTPS schemeful
site, such as `identity.example.com` and `chat.example.com`. Unrelated sites
need an explicit authorization-code handoff; direct credentialed browser
requests are not a substitute.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AUTH_SECRET` | Signs browser sessions and decrypts stored external-Agent credentials; keep stable across restarts |
| `EVELAND_PUBLIC_ORIGIN` | Eveland's single public frontdoor; defaults to `http://localhost:17300` in development |
| `EVELAND_IDENTITY_RETURN_TARGET` | Registered Eveland return target; defaults to the legacy-compatible `eve-chats` key |
| `EVELAND_INTERNAL_ORIGIN` | Optional server-reachable frontdoor for the `/api/identity/*` rewrite, Catalog, and default JWKS URL |
| `EVELAND_IDENTITY_ISSUER` | Optional exact Caller/App Token issuer; defaults to the public origin, but must keep the old value when an Eveland upgrade preserves it |
| `EVELAND_IDENTITY_JWKS_URL` | Optional server-reachable signing-key endpoint; defaults to `<internal-origin>/.well-known/jwks.json` |

Register the exact Dawn origin as the return target in Eveland System >
Identity and include it explicitly in Eveland's
`EVELAND_IDENTITY_ALLOWED_ORIGINS`. Older Dawn variable names remain accepted
as compatibility fallbacks, but new deployments should use the names above.
