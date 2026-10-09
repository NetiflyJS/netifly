# `@netiflyjs/client` reference

The browser/Node client — the receiving end of everything `@netiflyjs/core`
sends. **Zero runtime dependencies**, ~1.7 KB minified + gzipped, built on
the standard `WebSocket` global, so it runs unchanged in browsers, React
Native, and Node 22+ (the first Node release with `WebSocket` available
unflagged — hence this package's `engines: { node: ">=22" }`; the rest of
the repo still supports Node 18+).

## `createNetiflyClient<Events>(options)`

`new NetiflyClient<Events>(options)` is the identical class form. `Events`
is the same `EventMap` your server uses, so handlers are type-checked
against the payloads the server sends.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | ✅ | The Netifly WebSocket endpoint, e.g. `wss://api.example.com/netifly`. |
| `getToken` | `() => string \| Promise<string>` | — | Resolves the auth token, called again before **every** connection attempt so short-lived tokens are refreshed. Omit for cookie-based auth. |
| `tokenMode` | `'query' \| 'subprotocol'` | — | Where the token goes (see [Token auth](#token-auth)). Defaults to `'query'`. |
| `tokenQueryParam` | `string` | — | Query parameter name for `tokenMode: 'query'`. Defaults to `'token'`. |
| `tokenProtocolPrefix` | `string` | — | Subprotocol prefix for `tokenMode: 'subprotocol'`. Defaults to `'netifly.token.'`. |
| `baseDelayMs` | `number` | — | Base of the full-jitter backoff. Defaults to `500`. |
| `maxDelayMs` | `number` | — | Cap on the backoff window. Defaults to `30_000`. |
| `maxReconnectAttempts` | `number` | — | Consecutive reconnect attempts before giving up (going `closed`, reporting an error). Defaults to `Infinity` — the right default for a long-lived app that should survive an outage of any length. |
| `autoAck` | `boolean` | — | Auto-sends `{ type: 'ack', id }` on receipt of every application envelope (never for the server's own `netifly.*` relay frames). Defaults to `true`. Set `false` to avoid the extra outbound/Redis traffic (see the [multi-tab relay cost note](core.md#client-acks-and-read-state)), or to ack explicitly on your own schedule. |

Returns a `NetiflyClient<Events>`:

- `connect(): void` — opens the connection and keeps it open, reconnecting per the [table below](#reconnecting). A no-op while already open or connecting. Register handlers first so nothing is missed.
- `close(code = 1000, reason?): void` — shuts down for good: cancels any pending reconnect timer and closes the socket. **Never** triggers a reconnect. Call `connect()` again to start over.
- `on<K extends keyof Events & string>(type: K, handler: (data: Events[K], envelope: Envelope<Events[K]>) => void): () => void` — subscribes to one application event type; returns an unsubscribe function. The raw envelope is passed as a second argument when you need `id`/`ts`.
- `onAny(handler: (envelope: Envelope) => void): () => void` — every envelope, whatever its type — including relayed `netifly.ack`/`netifly.read`/`netifly.response` frames (see [below](#reserved-netifly-envelope-type-prefix)); filter on `envelope.type` if you only want application events.
- `markRead(id: string): void` — sends `{ type: 'read', id }`, so the server fires `'read'` and relays it to the user's other tabs/devices. Silent no-op if not currently connected.
- `respond(id: string, payload: unknown): void` — sends `{ type: 'response', id, payload }` with an arbitrary JSON-serializable payload, firing the server's `'response'` event. Same no-op-when-disconnected behavior as `markRead()`. ⚠️ `payload` counts against the server's `maxPayload` (default 4 KB) — an oversized payload **closes the connection** (code `1009`), otherwise never how this feature behaves for a bad/oversized frame. Keep `payload` small, or raise `maxPayload` on the server.
- `respondToAction(id, action, token, input?): void` — sends `{ type: 'action', id, action, token, input }`. `token` is the specific action's signed token from the notification payload — see [Actionable notifications](core.md#actionable-notifications). No-op if not connected.
- `onActionAck((info) => void): () => void` — the server's direct reply to `respondToAction()`: `{ id, action, status }`, `status: 'accepted' | 'already_answered' | 'expired' | 'invalid'`.
- `onResolved((info) => void): () => void` — `netifly.notification.resolved`: `{ id, action }`, fires on every one of the user's connections (including the one that answered) when an actionable notification is answered.
- `onNotification((data, envelope) => void): () => void` — subscribes to `notify()`-sent notifications specifically, typed as `WireNotification`. Purely additive — the same envelope still flows through `on('notification', ...)`/`onAny()` exactly as before; this is a convenience for the common case of wanting notifications on their own channel.
- `onStateChange(handler: (state: ConnectionState) => void): () => void` — connection lifecycle: `'connecting'` (handshake in flight), `'open'`, `'reconnecting'` (waiting out a backoff delay), `'closed'` (down and not retrying).
- `onClose(handler: ({ code, reason, wasClean }) => void): () => void` — the raw close event, for logging or your own policy on top.
- `onError(handler: (error: Error) => void): () => void` — a rejected `getToken()`, an unparseable message, a throwing handler (which never breaks the other handlers), or giving up after `maxReconnectAttempts`.
- `state: ConnectionState` — current state, same values as `onStateChange`.
- `lastEventId: string | undefined` — `id` of the most recent envelope received, tracked for future replay support (see [Replay](#replay-lasteventid)).
- `protocol: string` — the subprotocol the server selected, or `''`.

The package also exports `fullJitterDelay(attempt, base, cap)` and
`planReconnect(wasOpen, code)` — the pure functions behind the
[reconnect table](#reconnecting) — plus the `Envelope`, `EventMap`,
`ConnectionState`, `CloseInfo` and `NetiflyClientOptions` types and
`ENVELOPE_VERSION`. `Envelope`/`EventMap` are deliberately re-declared here
rather than imported from `@netiflyjs/core` (which would pull `ws` and
`ioredis` into a browser bundle); they describe the same
[wire contract](core.md#message-envelope) both sides implement. The
notification shapes (`Notification`, `InfoNotification`,
`ActionNotification`, `NotificationAction`, `WireNotification`,
`NotificationSeverity`, `NotificationLink`) are re-declared the same way,
for `onNotification()` above.

## Reconnecting

Reconnect delays use the AWS
[Full Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
formula — `delay = random(0, min(cap, base * 2^attempt))` — so a fleet of
clients coming back after an outage spreads out instead of re-stampeding
the server in lockstep waves. `base` is `baseDelayMs` (default `500`) and
`cap` is `maxDelayMs` (default `30_000`); the attempt counter resets on
every successful connection.

What a disconnect means depends on whether the connection had ever opened:

| Situation | Client behavior |
| --- | --- |
| The handshake never completed (the very first `open` never fired) | Exponential backoff with full jitter — see the caveat below |
| Closed with `1000` (Normal Closure) or `1005` (no status) after being open | Stays `closed`. `netifly.disconnect(userId)` on the server produces `1005`, an intentional server-side disconnect, not a fault |
| Closed with `1012` (Service Restart) after being open | Reconnects **immediately**, with a single jittered delay drawn from the base window only — no exponential ramp. This is what `netifly.close()` sends on a graceful deploy |
| Any other close code after being open (`1001`, `1006`, `1011`, `1013`, …) | Treated as transient: exponential backoff with full jitter |
| Your app called `client.close()` | Never reconnects, whatever close code results |

> ⚠️ **A browser cannot see why a handshake failed.** Per the WHATWG
> WebSocket spec, a rejected upgrade gives JavaScript no access to the HTTP
> response: whether Netifly answered `401 Unauthorized`, `403 Forbidden`
> (origin check), or `429 Too Many Requests`, the client receives the exact
> same bare `close` event — code `1006`, `wasClean: false` — as it would for
> an unreachable host or dropped Wi-Fi. There is therefore **no
> spec-compliant way** for this client to treat `401`/`403` as terminal
> while retrying `429`, and it does not pretend otherwise: every
> never-opened failure is retried with backoff, because giving up on what
> was actually a network blip would strand a legitimate user offline. If
> your app needs auth-aware behavior, detect the invalid session over plain
> HTTP (where the status code *is* visible) and call `client.close()`
> yourself. Set `maxReconnectAttempts` if you'd rather the client eventually
> give up on its own. Node 22's bundled undici fires only an `error` event
> for a failed handshake (no `close` at all, unlike browsers and Node 24+);
> the client normalizes the two into one close so a retry always happens.

See the [recipe on handling reconnects and token refresh](../recipes/client-reconnects-and-token-refresh.md)
for a worked example.

## Token auth

Browsers can't set request headers on a WebSocket handshake, so a bearer
token has exactly two places to go. `getToken()` is called again before
**every** connection attempt, so short-lived tokens are refreshed rather
than reused past expiry.

**Query string (default, recommended):**

```ts
createNetiflyClient({ url: 'wss://api.example.com/netifly', getToken: () => token });
// connects to  wss://api.example.com/netifly?token=<token>
```

Server side, `resolveUserId` reads it straight off the raw request:

```ts
resolveUserId: (req) => verifyJwt(new URL(req.url, 'http://x').searchParams.get('token')),
```

Rename the parameter with `tokenQueryParam: 'access_token'`. URLs are more
likely to end up in access logs than headers are — prefer short-lived
tokens, and see [Security → Cookie vs. token auth](../security.md#cookie-vs-token-auth).

**Subprotocol:**

```ts
createNetiflyClient({ url, getToken: () => token, tokenMode: 'subprotocol' });
// offers Sec-WebSocket-Protocol: netifly.token.<token>
```

```ts
resolveUserId: (req) => {
  const offered = req.headers['sec-websocket-protocol'];
  const match = offered?.split(',').map((p) => p.trim()).find((p) => p.startsWith('netifly.token.'));
  return match ? verifyJwt(match.slice('netifly.token.'.length)) : null;
},
```

This mode **works today** against a `createNetifly()` server, verified by
integration test. Some background, since RFC 6455 §4.1 says a strict
client must fail the connection if the server doesn't select one of the
offered subprotocols: `@netiflyjs/core` passes no `handleProtocols` option
to `ws`, and `ws`'s default in that case is to echo back the *first*
subprotocol the client offered — so the handshake completes and
`client.protocol` reports `netifly.token.<token>`. Change the prefix with
`tokenProtocolPrefix`. A subprotocol must be a valid HTTP token — no commas
or spaces — which JWTs and other base64url tokens satisfy.

Omit `getToken` entirely for cookie-based auth; the browser attaches
cookies to the upgrade request on its own (and then the
[origin allowlist](../security.md#origin-allowlist) protects you from
CSWSH).

## Replay (`lastEventId`)

`client.lastEventId` is the `id` of the most recent
[envelope](core.md#message-envelope) received — a sortable ULID. The
client tracks it but does not yet resume from it; it's here so apps can
persist it now, ahead of replay-on-reconnect support.

## Reserved `netifly.` envelope type prefix

Relayed acks/reads/responses (see
[Client acks and read state](core.md#client-acks-and-read-state)) arrive as
ordinary envelopes with `type` set to `'netifly.ack'`, `'netifly.read'`,
`'netifly.response'`, `'netifly.actionAck'`, or
`'netifly.notification.resolved'` — this reuses the existing `on()`/
`onAny()` path with no new client-side parsing. Don't use a
`netifly.`-prefixed key in your own `Events` map: `autoAck` skips these
types on purpose (acking a relay frame would ack the wrong `id`), so a
colliding app event would silently never get auto-acked.

## Pure reconnect functions

Exported so the reconnect policy can be unit-tested (or reused) without a
real socket:

- `fullJitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number` — `random(0, min(maxDelayMs, baseDelayMs * 2^attempt))`, the AWS Full Jitter formula behind the [reconnect table](#reconnecting).
- `planReconnect(wasOpen: boolean, code: number): ReconnectPlan` — decides what a close means from the two facts a standard WebSocket client has (did it ever open, and the close code). Returns a `ReconnectPlan`.
- `ReconnectPlan` (type) — `'none' | 'immediate-jitter' | 'backoff'`: stay down, reconnect now with a single jittered delay, or back off exponentially.

## All exports

Every name `@netiflyjs/client` exports from its package entry point. Items
explained in a section above link there.

**Functions & values**

| Export | Description |
| --- | --- |
| `createNetiflyClient` / `NetiflyClient` | See [`createNetiflyClient<Events>(options)`](#createnetiflyclienteventsoptions) — `NetiflyClient` is the equivalent class (`new NetiflyClient(options)`). |
| `fullJitterDelay` | See [Pure reconnect functions](#pure-reconnect-functions). |
| `planReconnect` | See [Pure reconnect functions](#pure-reconnect-functions). |
| `ENVELOPE_VERSION` | The numeric constant (`1`) found on every received [envelope](core.md#message-envelope)'s `v` field — re-exported here so client code can check it without importing `@netiflyjs/core`. |

**Types**

| Export | Description |
| --- | --- |
| `EventMap` | `Record<string, unknown>` — the shape an `Events` type parameter must satisfy. Re-declared from `@netiflyjs/core`'s identical type so this package never imports `ws`/`ioredis`. |
| `Envelope<T>` | The wire envelope shape — see [`core`'s Message envelope](core.md#message-envelope). |
| `ConnectionState` | `'connecting' \| 'open' \| 'closed' \| 'reconnecting'` — the type of `client.state` and `onStateChange`'s argument. |
| `TokenMode` | `'query' \| 'subprotocol'` — the `tokenMode` option. See [Token auth](#token-auth). |
| `CloseInfo` | `{ code, reason, wasClean }` — the subset of a `CloseEvent` `onClose()` surfaces. |
| `ActionAckInfo` | `{ id, action, status }` — payload for `onActionAck()`. See [Actionable notifications](core.md#actionable-notifications). |
| `ResolvedInfo` | `{ id, action }` — payload for `onResolved()` (the `netifly.notification.resolved` relay). |
| `NetiflyClientOptions` | The full options object `createNetiflyClient<Events>()` takes — see the [option table](#createnetiflyclienteventsoptions). |
| `ReconnectPlan` | See [Pure reconnect functions](#pure-reconnect-functions). |
| `Notification` / `InfoNotification` / `ActionNotification` / `NotificationAction` / `NotificationLink` / `NotificationSeverity` | Re-declared from `@netiflyjs/core`'s identical types, for `onNotification()` — see [`core`'s Events vs. notifications](core.md#events-vs-notifications) and [Actionable notifications](core.md#actionable-notifications). |
| `WireNotification` | What a client actually receives — see [`core`'s Actionable notifications](core.md#actionable-notifications). |

## See also

- [Getting started](../getting-started.md)
- [Security](../security.md)
- [Recipe: handling reconnects and token refresh](../recipes/client-reconnects-and-token-refresh.md)
- [`core` reference](core.md) · [`express` reference](express.md) · [`react` reference](react.md)
