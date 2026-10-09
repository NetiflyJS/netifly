# `@netiflyjs/core` reference

The framework-agnostic engine. Attaches to any Node `http.Server` and moves
messages between connections — and across server instances — through a
pluggable `NetiflyTransport` (Redis by default).

## `createNetifly<Events>(options)`

`Events` is an optional type parameter — an `EventMap` (`Record<string, unknown>`)
mapping event names to payload shapes — that type-checks `send`/`sendOr`
below. Defaults to `Record<string, unknown>`, so calling `createNetifly(options)`
with no type argument behaves exactly as if every `type`/`data` pair were
allowed.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `server` | `http.Server` | ✅ | The server to attach the WebSocket upgrade handler to. |
| `resolveUserId` | `(req) => string \| null \| undefined \| Promise<...>` | ✅ | Identifies the connecting user. Returning a falsy value rejects the connection. |
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL`. Ignored if `transport` is passed. One of `redisUrl` / `REDIS_URL` / `transport` **must** be provided — Netifly throws at construction time otherwise (no local-Redis fallback). |
| `transport` | `NetiflyTransport` | — | The transport used to move messages between connections and server instances (see [Transport](#transport) below). Defaults to a Redis transport built from `redisUrl`/`namespace`. Passing both `transport` and `namespace` throws at construction time. |
| `path` | `string` | — | WebSocket upgrade path. Defaults to `/netifly`. |
| `allowedOrigins` | `(string \| RegExp)[] \| ((origin: string \| undefined) => boolean) \| '*'` | — | Controls the CSWSH origin check — see [Security](../security.md). Defaults to same-host only. |
| `maxPayload` | `number` | — | Max inbound WebSocket frame size in bytes. Netifly ignores client→server messages, so this just bounds memory/DoS exposure from `ws`'s 100 MiB default; an oversized frame closes the connection with code `1009`. Defaults to `4096`. |
| `maxBufferedBytes` | `number` | — | Max bytes allowed in a connection's outbound send buffer (`ws.bufferedAmount`) before it's treated as stalled and shed — see [Security → Limits](../security.md#limits). Defaults to `1_048_576` (1 MB). |
| `maxConnectionsPerUser` | `number` | — | Max concurrent WebSocket connections for one `userId`, **on this instance**. Defaults to `10`. |
| `maxInboundFramesPerSecond` | `number` | — | Max inbound client frames (ack/read/response) accepted per connection, per second, via a per-connection token bucket shared across all three frame kinds. Frames beyond the limit are dropped and counted via `'malformedFrame'` (`reason: 'rateLimited'`) rather than closing the connection. Defaults to `20`. |
| `namespace` | `string` | — | Scopes Redis channel names to `netifly:<namespace>:user:<id>` instead of `netifly:user:<id>` — use when multiple apps/environments share one Redis instance. Only meaningful when building the default transport from `redisUrl`; pass it to `redisTransport(url, { namespace })` directly if passing `transport` explicitly. |
| `validate` | `(type: K, data: Events[K]) => void` | — | Runtime validation hook (e.g. a Zod/Valibot schema lookup), called with the resolved `(type, data)` pair before every `send()`/`sendOr()` publishes. Throwing aborts the send and propagates out of the call. |
| `actionSecret` | `string \| false` | — | HMAC secret for signing `kind: 'action'` notification tokens — see [Actionable notifications](#actionable-notifications). Falls back to `process.env.NETIFLY_SECRET`. **Throws at construction** unless a secret is resolved or this is explicitly `false` (disables `kind: 'action'` for this server). |

Returns a `NetiflyInstance<Events>`:

- `send<T>(userId, payload: T): Promise<SendResult>` — wraps `payload` as `{ v, id, type: "message", data: payload, ts }` and delivers it to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere.
- `send<K extends keyof Events & string>(userId, type: K, data: Events[K]): Promise<SendResult>` — same delivery semantics, with the `type` you provide. Type-checked against `Events` when a concrete map was passed to `createNetifly<Events>()` (see [Typed events](#typed-events)).
  - `SendResult` is `{ delivered: boolean; instances: number }`. `instances` is the number of server instances that held a live connection for `userId` at publish time (the Redis `PUBLISH` subscriber count). `delivered` is `instances > 0`.
  - ⚠️ `delivered: true` means the message reached a server process holding a live socket — not that the client rendered it. For that, listen for `'delivered'`/`'read'` below.
- `sendOr<T>(userId, payload, { offline })` / `sendOr<K>(userId, type, data, { offline })` — calls `send()`, and if the result is `{ delivered: false }`, calls `options.offline()` (awaited if it returns a promise) before resolving. Always resolves with the same `SendResult` `send()` would have. A rejection from `offline()` propagates out.
- `notify(userId, notification): Promise<SendResult>` / `notifyOr(userId, notification, options): Promise<SendResult>` — validated, opinionated counterparts to `send()`/`sendOr()` for user-facing notifications (see [Events vs. notifications](#events-vs-notifications) and [Actionable notifications](#actionable-notifications)). A validation failure throws `NotificationValidationError` synchronously and nothing is published. Publishes with envelope `type: "notification"`.
- `on('action', ({ userId, notificationId, actionId, input, context }) => void)` — fires exactly once per answered `kind: 'action'` notification. `context` is recovered from the signed token, never trusted from the client. Also relayed to the user's other connections as `netifly.notification.resolved`; the answering socket gets `netifly.actionAck` with `status: 'accepted' | 'already_answered' | 'expired' | 'invalid'`.
- `disconnect(userId): void` — **local-only**: only closes connections on this instance. Not a cluster-wide "force logout." Prefer short-lived tokens `resolveUserId` can reject once revoked, or broadcast your own `disconnect()` call to every instance.
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`, `on('reject', ({ reason, status, ... }) => void)`, `on('dropped', ({ userId, reason }) => void)` — **attaching `'error'` is effectively required in production**: an unhandled `'error'` emit with no listener crashes the process, so without one, transport failures are invisible.
  - `reject`: `reason: 'origin'` (`{ status: 403, origin, req }`), `reason: 'maxConnectionsPerUser'` (`{ status: 429, userId, req }`, per-instance only), `reason: 'auth'` (`{ status: 401, error, req }` when `resolveUserId` rejects or throws).
  - `dropped`: `reason: 'maxBufferedBytes'` — that connection was skipped for a delivery and closed with code `1013`; the same `send()` still reaches the user's other, healthy connections.
- `on('sent', ({ userId, id, type, data }) => void)` — fires synchronously inside `send()`/`sendOr()` with the generated envelope id, before publishing. Good place to persist a notification record at send time.
- `on('delivered' | 'read', ({ userId, id, ts }) => void)` — fires when a client sends `{ type: 'ack' | 'read', id }` back, exactly once per client action. Relayed to the user's other connections as `netifly.ack`/`netifly.read` — see [Client acks and read state](#client-acks-and-read-state).
- `on('response', ({ userId, id, payload, ts }) => void)` — fires on `{ type: 'response', id, payload }` (e.g. a reply to an action button via `client.respond()`). Relayed as `netifly.response`.
- `on('malformedFrame', ({ userId, reason }) => void)` — fires instead of throwing for an invalid inbound client frame (`reason: 'invalidJson' | 'invalidShape' | 'rateLimited'`). Never closes the connection.
- `close(options?: { drainMs?: number; force?: boolean }): Promise<void>` — graceful shutdown: stops the heartbeat, closes the WS server, closes the transport. By default, every client gets a close frame with code `1012` ("Service Restart") and up to `drainMs` (default `5000`) to close itself before stragglers are force-terminated. Pass `{ force: true }` to `terminate()` everything immediately instead. Always resolves, even if clients never acknowledge.
- `isOnline(userId): Promise<boolean>` — whether `userId` has a live connection anywhere in the cluster. With the default Redis transport, derived from `PUBSUB NUMSUB`. **Accurate only within the heartbeat interval** (`30s`) — an unclean disconnect can leave the channel subscribed until the heartbeat notices and terminates the dead socket.
- `whoIsOnline(userIds): Promise<Record<string, boolean>>` — batched `isOnline`, one round-trip for the whole array. Resolves `{}` for an empty array with no Redis round-trip.
- `isConnectedHere(userId): boolean` — synchronous, local-only: whether `userId` has a live connection **on this instance**, no Redis round-trip.

## `createNetiflyPublisher<Events>(options)`

For processes that don't hold any WebSocket connections — workers, cron
jobs, serverless functions. Supports the same `Events`/`validate` contract
as `createNetifly`.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL`. One of the two **must** be provided — throws at construction otherwise, same as `createNetifly`. |
| `namespace` | `string` | — | Must match the `namespace` used by the `createNetifly()` server(s) this publisher should reach. |
| `validate` | `(type, data) => void` | — | Same hook as `createNetifly`'s `validate`. |
| `actionSecret` | `string \| false` | — | Must match the secret used by the `createNetifly()` server(s) this publisher should reach — only a connected server, never a publisher, verifies an action answer. |

Returns a `NetiflyPublisher<Events>` — lighter-weight, send-only, backed by
a single lazily-connected Redis client (connects on first use, not at
construction):

- `send<T>(userId, payload)` / `send<K>(userId, type, data)` — identical envelope/delivery semantics to `NetiflyInstance.send()`.
- `notify(userId, notification)` — same validated API as `NetiflyInstance.notify()`. No `notifyOr()` (matching the publisher's existing `send()`-only, no-`sendOr()` surface).
- `isOnline(userId)` / `whoIsOnline(userIds)` — identical semantics to `NetiflyInstance`'s.
- `close(): Promise<void>` — disconnects the publisher's Redis connection. Call before a short-lived process exits. Calling any method after `close()` throws `Netifly: cannot use publisher after close()`.

See [Recipe: notify from a BullMQ worker](../recipes/notify-from-a-bullmq-worker.md).

## Transport

`createNetifly()` moves messages between connections — and across server
instances — through a `NetiflyTransport`. Passing `redisUrl` (or setting
`REDIS_URL`) is sugar for building the default one:
`redisTransport(redisUrl, { namespace })`.

```ts
import { createNetifly, redisTransport, memoryTransport } from '@netiflyjs/core';

// Explicit, namespaced Redis transport — identical to the redisUrl/namespace sugar.
createNetifly({
  server,
  resolveUserId,
  transport: redisTransport(process.env.REDIS_URL!, { namespace: 'staging' }),
});

// Local development and tests — no Redis required.
createNetifly({ server, resolveUserId, transport: memoryTransport() });
```

`memoryTransport()` is a single-process, dependency-free transport —
recommended for running your own app's test suite against Netifly without
standing up a real Redis instance. It models exactly one process: it
doesn't simulate a multi-instance cluster, so cross-instance behavior
(presence via `isOnline()`/`whoIsOnline()`, or delivery to a connection
held by a different instance) should still be tested against
`redisTransport()` if your app depends on it.

A transport instance belongs to exactly one `createNetifly()` call — its
`onMessage`/`onError` callbacks are single-slot, so passing the same
instance to two `createNetifly()` calls means the second silently
overwrites the first's delivery callback, and each call's independent
ref-counting can tear down the other's subscriptions. `netifly.close()`
closes the transport it was given, too.

## Typed events

Give `createNetifly()` an `Events` map and `send()`/`sendOr()` become
type-checked against it:

```ts
type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

const netifly = createNetifly<Events>({ server, resolveUserId });

netifly.send(userId, 'export.ready', { url });        // ✅ type-checks
netifly.send(userId, 'export.ready', { url: 123 });   // ❌ type error: wrong payload shape
netifly.send(userId, 'not.a.real.event', {});          // ❌ type error: unknown event name
```

`Events` is a plain, exported `EventMap` (`Record<string, unknown>`) —
nothing core-specific — so the same type can be shared with the client side
for typed handlers on the receiving end (see the
[`client` reference](client.md)). `createNetiflyPublisher<Events>()`
supports the identical pattern. Calling either with no type argument still
works exactly as before — `Events` defaults to `Record<string, unknown>`.

For runtime enforcement (e.g. with [Zod](https://zod.dev) or
[Valibot](https://valibot.dev)), pass a `validate` function — see the
option table above.

## Events vs. notifications

`send()`/`sendOr()` move whatever `type`/`data` your app defines — Netifly
has no opinion on the shape. `notify()`/`notifyOr()` are a thin, opinionated
layer over the same delivery path (same envelope, same `SendResult`, same
`sendOr`-style offline fallback), for the specific case of a user-facing
notification:

```ts
await netifly.notify(userId, {
  kind: 'info',
  title: 'Export ready',
  body: 'Your March report has finished generating.',
  severity: 'success',
  link: { href: '/reports/123', label: 'Open' },
  expiresAt: Date.now() + 24 * 3600_000,
});
```

Use `send()` for app-internal events a client-side handler reacts to
programmatically. Use `notify()` when the payload *is* the thing a human
reads — Netifly validates it server-side (`title`/`body` length limits, a
safe `link.href` that rejects `javascript:`/`data:`/other unsafe schemes)
and gives every notification a consistent shape your UI can render
generically. A failing `notify()` call throws `NotificationValidationError`
(exported from `@netiflyjs/core`) synchronously, before anything is
published.

On the wire, `notify()` publishes with envelope `type: "notification"` — an
ordinary, unprefixed type, so it flows through the client's normal
auto-ack and `lastEventId` tracking exactly like any `send()`-originated
message. A typed `NetiflyClient<Events>` subscribes to it the same way it
subscribes to any app event: add a `notification` entry to your `Events`
map, then call `client.on('notification', ...)` (see the
[`client` reference](client.md)).

For contexts without direct access to the TypeScript types — a non-Node
publisher validating a payload before sending, say — `@netiflyjs/core` also
exports `notificationJsonSchema`, a JSON Schema (draft-07) describing the
same shape.

## Actionable notifications

`notify()` with `kind: 'action'` adds CTA buttons a user can answer
directly — Approve/Reject/Snooze-style — with the answer cryptographically
verified server-side before your app ever sees it:

```ts
await netifly.notify(userId, {
  kind: 'action',
  title: 'Approve expense £420?',
  body: 'Submitted by Sam for Client dinner',
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
  ],
  expiresAt: Date.now() + 24 * 3600_000,
  context: { expenseId: 'exp_123' }, // stays server-side; signed into each action's token
});

netifly.on('action', ({ userId, notificationId, actionId, context }) => {
  const { expenseId } = context as { expenseId: string };
  db.expenses.update(expenseId, { status: actionId }); // 'approve' | 'reject'
});
```

Requires `actionSecret` (or `NETIFLY_SECRET`) — `createNetifly()`/
`createNetiflyPublisher()` throw at construction unless one is configured,
or you pass `{ actionSecret: false }` to explicitly disable `kind: 'action'`
for that server. This is deliberate: an actionable notification's security
depends entirely on the signing secret, so a missing one fails loudly at
startup rather than silently accepting unsigned/unverifiable actions.

On the client, render each `action.token` and echo it back when the user
responds — see the [`client` reference](client.md#createnetiflyclienteventsoptions).

**How it's secure**: each action's token is
`base64url({ notificationId, userId, actionId, expiresAt, context }) + '.' + HMAC-SHA256(secret, ...)`
— signed, not encrypted, so the server never has to look anything up to
recover `context`; it's stateless across instances. On answer, the server
verifies the signature (timing-safe), that the token's `userId` matches
the answering socket's authenticated user, that it hasn't expired, and —
via a Redis `SET NX EX` lock — that nobody has answered this notification's
action already.

## Low-level action-token exports

`createNetifly()`/`createNetiflyPublisher()` use these internally for
[actionable notifications](#actionable-notifications); they're exported
for the rare case of building infra that needs the same primitives outside
a `NetiflyInstance` (e.g. a separate service that only verifies answers).

- `resolveActionSecret(optionValue: string | false | undefined): string | undefined` — the same secret-resolution `createNetifly`'s `actionSecret` option uses: returns the given string, else `process.env.NETIFLY_SECRET`, else throws — unless `optionValue === false`, which resolves to `undefined` (actions explicitly disabled).
- `signActionToken(payload: ActionTokenPayload, secret: string): string` — signs a token as `base64url(JSON.stringify(payload)) + '.' + HMAC-SHA256(secret, ...)`.
- `verifyActionToken(token: string, secret: string): VerifyActionTokenResult` — verifies a token produced by `signActionToken`: timing-safe signature check, then structural validation of the decoded payload. Never throws — every failure mode comes back as `{ ok: false, reason: 'invalid' }`; success is `{ ok: true, payload }`.
- `buildActionWireNotification(...)` — builds the `WireNotification` a client receives for a `kind: 'action'` notification, replacing each action's `context` with a signed `token` (see [Actionable notifications](#actionable-notifications)).
- `validateNotification(notification: Notification): void` — the same validation `notify()` runs internally (non-empty `title`/`body` within length limits, a safe `link.href`, 1–5 uniquely-`id`'d `actions`, etc.). Exported so you can validate a notification shape ahead of time, without actually sending it. Throws `NotificationValidationError` on failure.
- `NotificationValidationError` — the `Error` subclass `notify()`/`notifyOr()`/`validateNotification()` throw on an invalid notification. Exported so apps can `instanceof`-check it apart from other errors a call might reject with.
- `ActionTokenPayload` (type) — the payload signed into every action token: `{ nid, uid, aid, exp, ctx }` (notification id, user id, action id, expiry, context-or-`null`).
- `VerifyActionTokenResult` (type) — `{ ok: true; payload: ActionTokenPayload } | { ok: false; reason: 'invalid' }`.

## Message envelope

This is a **public wire contract**: every message Netifly delivers over
the WebSocket is wrapped in this envelope:

```json
{
  "v": 1,
  "id": "01J6ZQK6NQK4WQ1G7F1QK1TCP0",
  "type": "comment.created",
  "data": { "commentId": 42 },
  "ts": 1727180000000
}
```

| Field | Type | Description |
| --- | --- | --- |
| `v` | `number` | Envelope format version. Currently always `1`. |
| `id` | `string` | A server-generated [ULID](https://github.com/ulid/spec) — lexicographically sortable by creation time. Guaranteed unique and strictly increasing for sends issued by the same server instance. Ordering is **not** guaranteed across different server instances. |
| `type` | `string` | The event name. Defaults to `"message"` when using `send(userId, payload)`. |
| `data` | `T` | Your payload, whatever JSON-serializable shape it is. |
| `ts` | `number` | Server timestamp (`Date.now()`) at envelope creation. |

Non-Node publishers (e.g. publishing directly to a Netifly Redis channel
from another language) should produce messages in this exact shape so
clients parse them consistently — see
[Publishing directly, without this library](#publishing-directly-without-this-library).

## Client acks and read state

- `on('sent', ...)`, `on('delivered' | 'read', ...)`, `on('response', ...)`, `on('malformedFrame', ...)` — documented above under `createNetifly`'s return value.
- ⚠️ **Listeners on these events, and `NetiflyPublisher`'s `'sent'`, are isolated** — a listener that throws or returns a rejecting promise is caught and reported via `'error'` (dropped silently on `NetiflyPublisher`, which has no `'error'` event) rather than crashing the process or blocking other listeners. This matters because these events are triggered by a raw client frame — a hostile or buggy client can reach your listener on demand.
- ⚠️ **Multi-tab relay cost**: every accepted ack/read/response frame publishes a relay envelope to Redis, unconditionally — even for a user with exactly one connection (who then just receives an echo of their own action). A user with `N` open tabs/devices costs `N` relay publishes and up to `N²` relay deliveries per ack, and your hook fires once per tab, not once per notification. Dedupe by `id` in your hook if that matters to you.

## Publishing directly, without this library

Any language with a Redis client can `PUBLISH` directly, as long as it
matches Netifly's wire protocol:

1. **Channel name**: `netifly:user:<id>`, or `netifly:<namespace>:user:<id>` if the `createNetifly()` server(s) you're targeting use a `namespace`.
2. **Message body**: a JSON-encoded [envelope](#message-envelope) — `{ v, id, type, data, ts }`.

```python
import json, time, uuid, redis

r = redis.Redis.from_url("redis://127.0.0.1:6379")

envelope = {
    "v": 1,
    "id": str(uuid.uuid4()),
    "type": "export.ready",
    "data": {"url": "https://example.com/export.zip"},
    "ts": int(time.time() * 1000),
}

r.publish(f"netifly:user:{user_id}", json.dumps(envelope))
```

```go
envelope, _ := json.Marshal(map[string]any{
    "v":    1,
    "id":   uuid.NewString(),
    "type": "export.ready",
    "data": map[string]string{"url": "https://example.com/export.zip"},
    "ts":   time.Now().UnixMilli(),
})

rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
rdb.Publish(context.Background(), fmt.Sprintf("netifly:user:%s", userID), envelope)
```

## All exports

Every name `@netiflyjs/core` exports from its package entry point. Items
explained in a section above link there; the rest are documented inline
below.

**Functions & values**

| Export | Description |
| --- | --- |
| `createNetifly` | See [`createNetifly<Events>(options)`](#createnetiflyeventsoptions). |
| `createNetiflyPublisher` | See [`createNetiflyPublisher<Events>(options)`](#createnetiflypublishereventsoptions). |
| `memoryTransport` | See [Transport](#transport). |
| `redisTransport` | See [Transport](#transport). |
| `NotificationValidationError` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `validateNotification` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `resolveActionSecret` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `signActionToken` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `verifyActionToken` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `buildActionWireNotification` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `notificationJsonSchema` | JSON Schema (draft-07) describing the `Notification` shape, for runtime validation outside TypeScript — see [Events vs. notifications](#events-vs-notifications). |
| `ENVELOPE_VERSION` | The numeric constant (`1`) written to every [envelope](#message-envelope)'s `v` field. |

**Types**

| Export | Description |
| --- | --- |
| `UserId` | `string` — the id type `resolveUserId` returns and every method takes. |
| `EventMap` | `Record<string, unknown>` — the shape an `Events` type parameter must satisfy. See [Typed events](#typed-events). |
| `Envelope<T>` | The wire envelope shape — `{ v, id, type, data: T, ts }`. See [Message envelope](#message-envelope). |
| `ResolveUserId` | The type of the `resolveUserId` option: `(req: IncomingMessage) => UserId \| null \| undefined \| Promise<...>`. |
| `AllowedOrigins` | The type of the `allowedOrigins` option — see the [option table](#createnetiflyeventsoptions). |
| `NetiflyTransport` | The interface a custom `transport` must implement — see [Transport](#transport). |
| `CreateNetiflyOptions<Events>` | The full options object `createNetifly<Events>()` takes — see the [option table](#createnetiflyeventsoptions). |
| `CreateNetiflyPublisherOptions<Events>` | The options object `createNetiflyPublisher<Events>()` takes — see [`createNetiflyPublisher`](#createnetiflypublishereventsoptions). |
| `NetiflyInstance<Events>` | The return type of `createNetifly()` — see [`createNetifly<Events>(options)`](#createnetiflyeventsoptions). |
| `NetiflyPublisher<Events>` | The return type of `createNetiflyPublisher()` — see [`createNetiflyPublisher`](#createnetiflypublishereventsoptions). |
| `RedisTransportOptions` | Second argument to `redisTransport(url, options)` — currently just `{ namespace?: string }`. See [Transport](#transport). |
| `SendResult` | `{ delivered: boolean; instances: number }` — what every `send()`/`sendOr()`/`notify()` call resolves with. |
| `SendOrOptions` | `{ offline: () => void \| Promise<void> }` — the second argument to `sendOr()`/`notifyOr()`. |
| `CloseOptions` | `{ drainMs?: number; force?: boolean }` — the argument to `close()`. See the `close()` entry under [`createNetifly`](#createnetiflyeventsoptions). |
| `RejectInfo` | Payload for `on('reject', ...)` — a discriminated union on `reason`: `'origin'` (`{ status, origin, req }`), `'maxConnectionsPerUser'` (`{ status, userId, req }`), or `'auth'` (`{ status: 401, error, req }`). |
| `DroppedInfo` | Payload for `on('dropped', ...)` — `{ userId, reason: 'maxBufferedBytes' }`. |
| `AckInfo` | Payload for `on('delivered' \| 'read', ...)` — `{ userId, id, ts }`. |
| `ResponseInfo` | Payload for `on('response', ...)` — `{ userId, id, payload, ts }`. |
| `MalformedFrameReason` | `'invalidJson' \| 'invalidShape' \| 'rateLimited'` — the `reason` field of `MalformedFrameInfo`. |
| `MalformedFrameInfo` | Payload for `on('malformedFrame', ...)` — `{ userId, reason: MalformedFrameReason }`. |
| `SentInfo` | Payload for `on('sent', ...)` — `{ userId, id, type, data }`. |
| `ActionInfo` | Payload for `on('action', ...)` — `{ userId, notificationId, actionId, input?, context? }`. See [Actionable notifications](#actionable-notifications). |
| `Notification` | `InfoNotification \| ActionNotification` — what `notify()`/`notifyOr()` accept. |
| `InfoNotification` | `{ kind: 'info', title, body, severity?, link?, icon?, expiresAt?, meta? }`. See [Events vs. notifications](#events-vs-notifications). |
| `ActionNotification` | `{ kind: 'action', title, body, actions, expiresAt, context?, meta? }`. See [Actionable notifications](#actionable-notifications). |
| `NotificationAction` | One entry of `ActionNotification.actions` — `{ id, label, style?, input? }`. |
| `NotificationLink` | `InfoNotification.link` — `{ href, label }`. |
| `NotificationSeverity` | `'info' \| 'success' \| 'warning' \| 'error'` — `InfoNotification.severity`. |
| `WireNotification` | What a client actually receives on the wire — same as `Notification`, except an action notification's `actions[].context` is replaced by a signed `token`. See [Actionable notifications](#actionable-notifications). |
| `ActionTokenPayload` | See [Low-level action-token exports](#low-level-action-token-exports). |
| `VerifyActionTokenResult` | See [Low-level action-token exports](#low-level-action-token-exports). |

## See also

- [Getting started](../getting-started.md)
- [Security](../security.md)
- [Recipe: email when offline](../recipes/email-when-offline.md)
- [Recipe: notify from a BullMQ worker](../recipes/notify-from-a-bullmq-worker.md)
- [`express` reference](express.md) · [`client` reference](client.md) · [`react` reference](react.md)
