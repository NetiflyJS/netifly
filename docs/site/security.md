# Security

## Origin allowlist

WebSocket handshakes are exempt from the same-origin policy, and browsers
*do* send cookies cross-origin on the upgrade request — this is what makes
cross-site WebSocket hijacking (CSWSH) possible if `resolveUserId` derives
identity from a cookie-based session. Netifly checks the `Origin` header
**before** `resolveUserId` ever runs, so a forged cross-site request never
reaches your auth code.

By default (no `allowedOrigins` option), Netifly only accepts an `Origin`
that matches the request's `Host` header, and rejects everything else with
`403 Forbidden`. Non-browser clients that omit `Origin` entirely (raw `ws`
clients, server-to-server calls) are allowed through, since they aren't
subject to CSWSH.

> ⚠️ **Breaking change (pre-1.0 → 1.0):** earlier versions performed no
> Origin check at all. If your `Origin` legitimately differs from your
> `Host` — e.g. a reverse proxy or CDN in front that doesn't forward the
> original `Host`, or your WebSocket endpoint lives on a different
> subdomain than your app — upgrading will start rejecting those
> connections until you set `allowedOrigins` explicitly.

Customize it via `createNetifly()` / `attachNetifly()`:

```ts
// An explicit allowlist — strings match exactly, RegExp is tested against the header
allowedOrigins: ['https://app.example.com', /^https:\/\/[a-z]+\.example\.com$/]

// Or a predicate for full control (including rejecting a missing Origin)
allowedOrigins: (origin) => origin !== undefined && origin.endsWith('.example.com')

// Opt out entirely — e.g. for a token-in-query setup where CSWSH doesn't apply.
// Only do this if resolveUserId does NOT rely on cookies.
allowedOrigins: '*'
```

Rejections emit a `reject` event:
`netifly.on('reject', ({ reason, status, origin }) => { ... })`.

## Cookie vs. token auth

- **Cookie-based sessions** are convenient but exposed to cross-site
  WebSocket hijacking — the origin allowlist above is your defense if you
  use them.
- **Bearer tokens** (e.g. a short-lived JWT read from a query param or the
  `Sec-WebSocket-Protocol` header) sidestep cross-origin cookie replay
  entirely, since the browser only attaches them if your client code puts
  them there. This is the safer default if you control the client.

Beyond the Origin check, enforcement happens inside `resolveUserId` —
Netifly never inspects cookies or tokens itself. Returning a falsy value
from `resolveUserId` rejects the connection.

See [Token auth](getting-started.md) and the
[`client` reference](reference/client.md) for how `@netiflyjs/client` sends
a bearer token (`tokenMode: 'query' | 'subprotocol'`).

## Limits

Netifly ships with built-in defaults for the three most common abuse
vectors — inbound frame size, outbound buffer growth, and connections per
user — configurable via `createNetifly()` / `attachNetifly()` options (see
the [`core` reference](reference/core.md)):

- **Inbound frame size** — `maxPayload` (default `4096` bytes) bounds the
  size of any WebSocket frame a client sends. Netifly ignores
  client→server messages entirely, so this exists purely to cap
  memory/DoS exposure from `ws`'s 100 MiB default; an oversized frame
  closes the connection with code `1009`.
- **Outbound buffer growth** — `maxBufferedBytes` (default `1_048_576`,
  1 MB) bounds how much a `send()` is allowed to queue in a single
  connection's outbound buffer before that connection is considered
  stalled. A connection over the limit is skipped for that delivery,
  closed with code `1013`, and reported via the `dropped` event.
- **Connections per user** — `maxConnectionsPerUser` (default `10`) caps
  how many concurrent sockets one `userId` can hold **on a single
  instance**. Exceeding it rejects the upgrade with `429 Too Many
  Requests`. This is enforced per-instance only — in a multi-instance
  deployment a user could still hold `maxConnectionsPerUser` connections
  on *each* instance. Track a shared counter yourself (e.g. in Redis) if
  you need a cluster-wide cap.
- **Message rate** — Netifly has no built-in rate limiting on `send()`
  calls. Validate before calling it, or front the upgrade endpoint with a
  reverse proxy or API gateway that enforces rate limits.
- **`disconnect(userId)` is local-only** — it only closes connections on
  the local instance, so it is not a substitute for revoking a compromised
  session cluster-wide. Prefer short-lived auth tokens that `resolveUserId`
  rejects once revoked.
