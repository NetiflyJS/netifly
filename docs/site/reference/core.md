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

Returns a `NetiflyInstance<Events>`: `send`, `sendOr`, `disconnect`, `on`,
`close`, `isOnline`, `whoIsOnline`, `isConnectedHere`.

## `createNetiflyPublisher<Events>(options)`

Send-only counterpart for workers/serverless — no `server` option, no
subscriber connection. `redisUrl`, `namespace`, `validate` as above.
Returns `send`, `isOnline`, `whoIsOnline`, `close`.

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
