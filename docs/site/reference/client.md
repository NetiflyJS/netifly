# `@netiflyjs/client` reference

> **Status:** stub — full prose to follow. See the
> [root README's API Reference](https://github.com/NetiflyJS/netifly#-api-reference)
> for complete detail in the meantime.

Zero-dependency, ~1.7 KB gzipped, built on the standard `WebSocket` global
(browsers, React Native, Node 22+).

## `createNetiflyClient<Events>(options)`

| Option | Required | Notes |
| --- | --- | --- |
| `url` | ✅ | the Netifly WebSocket endpoint |
| `getToken` | — | called before every (re)connect; omit for cookie-based auth |
| `tokenMode` | — | `'query'` (default) or `'subprotocol'` |
| `tokenQueryParam`, `tokenProtocolPrefix` | — | naming overrides for the two token modes |
| `baseDelayMs`, `maxDelayMs` | — | full-jitter backoff tuning, defaults `500`/`30_000` |
| `maxReconnectAttempts` | — | default `Infinity` |
| `autoAck` | — | auto-send `{ type: 'ack', id }` on receipt of every application envelope, default `true` — see [Frontend hooks](#frontend-hooks) |

Returns a `NetiflyClient<Events>`: `connect`, `close`, `on`, `onAny`,
`markRead`, `respond`, `onStateChange`, `onClose`, `onError`, plus
`state`, `lastEventId`, `protocol`.

## Frontend hooks

- `markRead(id: string): void` — sends `{ type: 'read', id }`, so the
  server fires `'read'` (see the [core reference](core.md#backend-hooks))
  and relays it to the user's other tabs/devices. Silent no-op if not
  currently connected.
- `respond(id: string, payload: unknown): void` — sends
  `{ type: 'response', id, payload }` with an arbitrary
  JSON-serializable payload (e.g. a reply to an action button), firing
  the server's `'response'` event. Same no-op-when-disconnected behavior
  as `markRead()`. `payload` counts against the server's `maxPayload`
  (default 4 KB) — unlike every other bad-input path in this feature,
  `ws` enforces that by **closing the connection**, not by dropping the
  frame — keep `payload` small, or raise `maxPayload` on the server.
- **Auto-ack** (`autoAck`, default `true`): after dispatching a received
  application envelope to its handlers, the client automatically sends
  `{ type: 'ack', id }` back — unless `autoAck: false` was passed, or the
  envelope is one of the server's own `netifly.*` relay frames (see
  below), which are never auto-acked.

### `netifly.*` reserved type prefix

Relayed acks/reads/responses (from another tab, device, or instance)
arrive as ordinary envelopes — `on()`/`onAny()` need no new parsing —
with `type` set to `'netifly.ack'`, `'netifly.read'`, or
`'netifly.response'` and `data` shaped `{ id }` (`{ id, payload }` for
`'netifly.response'`). Don't use a `netifly.`-prefixed key in your own
`Events` map: auto-ack skips these types on purpose (acking a relay frame
would ack the wrong `id`), so a colliding app event would silently never
get auto-acked.

## Reconnect behavior

| Situation | Behavior |
| --- | --- |
| Handshake never completed | Exponential backoff, full jitter |
| Closed `1000`/`1005` after opening | Stays `closed` (intentional server disconnect) |
| Closed `1012` after opening | Reconnects immediately, single jittered delay (graceful deploy signal) |
| Any other close after opening | Treated as transient — exponential backoff |
| `client.close()` called | Never reconnects |

See [Getting started](../getting-started.md) for the full reconnect caveat
around handshake failures (browsers can't see *why* a handshake was
rejected — see the root README for the detailed explanation).

## To expand

- Full method signatures and worked examples for each token mode.
- The `fullJitterDelay`/`planReconnect` pure-function exports.
