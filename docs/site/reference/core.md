# `@netiflyjs/core` reference

> **Status:** stub — option/method names below are accurate as of the
> current release; full per-option prose to follow. See the
> [root README's API Reference](https://github.com/NetiflyJS/netifly#-api-reference)
> for complete detail in the meantime.

## `createNetifly<Events>(options)`

| Option | Required | Notes |
| --- | --- | --- |
| `server` | ✅ | `http.Server` to attach the WebSocket upgrade handler to |
| `resolveUserId` | ✅ | `(req) => userId \| falsy`, sync or async |
| `redisUrl` | — | falls back to `process.env.REDIS_URL`; one of the two is required |
| `path` | — | WebSocket upgrade path, default `/netifly` |
| `allowedOrigins` | — | see [Security](../security.md) |
| `maxPayload`, `maxBufferedBytes`, `maxConnectionsPerUser` | — | see [Security](../security.md) |
| `namespace` | — | scopes Redis channel names for shared Redis instances |
| `validate` | — | runtime `(type, data) => void` hook, e.g. a Zod schema check |
| `maxInboundFramesPerSecond` | — | per-connection token bucket over client `ack`/`read`/`response` frames (see [Backend hooks](#backend-hooks) below), default `20` |

Returns a `NetiflyInstance<Events>`: `send`, `sendOr`, `disconnect`, `on`,
`close`, `isOnline`, `whoIsOnline`, `isConnectedHere`.

## `createNetiflyPublisher<Events>(options)`

Send-only counterpart for workers/serverless — no `server` option, no
subscriber connection. `redisUrl`, `namespace`, `validate` as above.
Returns `send`, `on('sent', ...)`, `isOnline`, `whoIsOnline`, `close`.

## Backend hooks

Events on the `NetiflyInstance`/`NetiflyPublisher` returned above, via
`on(event, listener)` / `once(event, listener)`:

| Event | Fires when | Payload |
| --- | --- | --- |
| `'sent'` | synchronously inside `send()`/`sendOr()`, before publishing — on both `NetiflyInstance` and `NetiflyPublisher` | `{ userId, id, type, data }` |
| `'delivered'` \| `'read'` | a client sends `{ type: 'ack' \| 'read', id }` back over its WebSocket — exactly once, on whichever instance received the frame, never once per instance | `{ userId, id, ts }` |
| `'response'` | a client sends `{ type: 'response', id, payload }` (an arbitrary JSON payload) — see the client's `respond()` below | `{ userId, id, payload, ts }` |
| `'malformedFrame'` | an inbound client frame is invalid JSON, the wrong shape, or over `maxInboundFramesPerSecond` — never throws, never closes the connection | `{ userId, reason: 'invalidJson' \| 'invalidShape' \| 'rateLimited' }` |
| `'connect'` \| `'disconnect'` \| `'error'` \| `'reject'` \| `'dropped'` | connection lifecycle (see [To expand](#to-expand)) | — |

`'delivered'`/`'read'`/`'response'` are also relayed to the user's other
open connections (other tabs, devices, or instances) as `netifly.ack` /
`netifly.read` / `netifly.response` envelopes on the client side — see
[Frontend hooks](client.md#frontend-hooks) and
[`netifly.*` reserved type prefix](client.md#netifly-reserved-type-prefix).

Listeners on `'sent'`, `'delivered'`, `'read'`, `'response'`, and
`'malformedFrame'` are isolated: a listener that throws or returns a
rejecting promise is caught and reported via `'error'` (or dropped
silently on `NetiflyPublisher`, which has no `'error'` event) rather than
crashing the process or blocking sibling listeners for the same event.

## Message envelope

Every message delivered over the WebSocket is wrapped as
`{ v, id, type, data, ts }` — a public wire contract. `id` is a
sortable ULID; `ts` is `Date.now()` at send time. Non-Node publishers
should produce this exact shape when publishing directly to Netifly's Redis
channel (`netifly:user:<id>`, or `netifly:<namespace>:user:<id>`).

## To expand

- Full per-option prose (currently only in the root README).
- Full method signatures and return types with worked examples.
- The `reject`/`dropped` event payload shapes.
