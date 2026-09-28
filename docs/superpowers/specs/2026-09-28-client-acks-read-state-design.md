# Client Acks and Read State (delivered / read / response) — Design Spec

**Date:** 2026-09-28
**Status:** Approved for implementation planning
**Author:** dolufemi (with Claude Code)
**Tracking:** [NOT-30](https://linear.app/notifyjs/issue/NOT-30/client-acks-and-read-state-delivered-read-events)

## 1. Summary

Extend Netifly with a client → server direction: today the server ignores
every inbound WebSocket frame entirely (see the `maxPayload` doc comment in
[types.ts](../../../packages/core/src/types.ts) and `SendResult`'s note
that "delivery acknowledgements/read-receipts are out of scope"). This spec
adds three client-originated signals — delivery ack, read receipt, and an
arbitrary-payload response — plus a send-time persistence hook, without
changing the existing wire envelope or breaking `@netiflyjs/core`/
`@netiflyjs/client`'s current public API.

## 2. Relation to NOT-41

[NOT-41](https://linear.app/notifyjs/issue/NOT-41/notification-persistence-and-ackresponse-hooks)
("Notification persistence and ack/response hooks") covers overlapping
ground and has its own design doc
([2026-09-25-notification-hooks-design.md](./2026-09-25-notification-hooks-design.md)),
written a day after NOT-30 without either ticket referencing the other.
That design proposed a **breaking** change to the wire envelope
(`{v,id,type,data,ts}` → `{type,id,payload}`) and to `send()`'s return
type. Both are already shipped/relied upon by `@netiflyjs/client` (NOT-21),
so this spec does not adopt them.

What this spec *does* fold in from NOT-41, non-breaking:

- A `'sent'` hook (§7) for send-time persistence, in place of NOT-41's
  breaking "`send()` returns the id" — the id is handed to the app via the
  event instead.
- A `'response'` event/frame (§5) carrying an arbitrary JSON payload, as
  groundwork for [NOT-38](https://linear.app/notifyjs/issue/NOT-38)
  (action-button replies), which this ticket already blocks.
- Exactly-once hook firing (§6) rather than a naive cluster-wide broadcast,
  for the same reason NOT-41 called out: an app whose hook does a
  non-idempotent `INSERT` shouldn't see the same ack fire once per
  instance.

Recommendation once this ships: close NOT-41 as superseded by NOT-30, or
narrow it to whatever (if anything) is still unaddressed.

## 3. Goals

- Let a client acknowledge delivery (`ack`) and mark-as-read (`read`) for a
  received notification, and send an arbitrary-payload `response` (e.g. a
  CTA button reply), with no wire envelope change.
- Let the app observe these via `on('delivered' | 'read' | 'response', ...)`
  on `NetiflyInstance`, firing exactly once per client action — never once
  per server instance.
- Let the app persist a notification record at send time via
  `on('sent', ...)`, without changing `send()`'s existing return type.
- Sync `delivered`/`read`/`response` across a user's other live connections
  (multi-tab/multi-device) by reusing the existing per-user Redis channel
  and delivery path — no new channel.
- Validate every inbound frame strictly; a malformed or excessive frame is
  dropped and counted, never crashes the connection or the process.
- Stay storage-agnostic: Netifly does not persist anything itself, and does
  not validate that an acked/read/responded `id` corresponds to a
  notification it actually sent (same trust model as `resolveUserId`).

## 4. Non-goals

- No envelope or `send()` return-type breaking changes (see §2).
- No deduplication of the echo a client receives of its own relayed
  ack/read/response (see §6) — same accepted behavior as NOT-41 proposed.
- `NetiflyPublisher` (the Redis-only, no-WebSocket handle for
  workers/serverless) does not gain `on('delivered'|'read'|'response')` —
  it structurally can never be "the instance that received the client's
  frame," so it stays out of the exactly-once model. It does gain
  `on('sent', ...)`, which is purely local to the calling process either
  way. Revisit publisher-side ack visibility as a separate ticket if a real
  need shows up.
- No unread-count helper — the ticket's optional item depended on replay-
  on-reconnect, which isn't built yet ([client.ts](../../../packages/client/src/client.ts)
  notes it's planned for a future version). Revisit once replay ships.
- No app-level idempotency/dedup of repeated acks (e.g. the same `id`
  acked twice across a reconnect) — the app's own persistence layer
  handles that the same way it would handle any other retried write.

## 5. Wire protocol

**Client → server** (new — the first client-originated frames Netifly ever
reads), sent on the client's existing single WebSocket connection:

```json
{ "type": "ack", "id": "<envelope id>" }
{ "type": "read", "id": "<envelope id>" }
{ "type": "response", "id": "<envelope id>", "payload": <any JSON> }
```

No `{v, ts}` wrapper — these are narrow control frames, not application
messages, and don't need envelope versioning of their own.

**Server → client relay** (existing envelope shape, reserved `type`
namespace, published to the same `netifly:user:<id>` channel `send()`
already uses):

```json
{ "v": 1, "id": "<relay id>", "type": "netifly.ack",      "data": { "id": "<original id>" },                    "ts": 1234 }
{ "v": 1, "id": "<relay id>", "type": "netifly.read",     "data": { "id": "<original id>" },                    "ts": 1234 }
{ "v": 1, "id": "<relay id>", "type": "netifly.response", "data": { "id": "<original id>", "payload": <any> },  "ts": 1234 }
```

Reusing the standard envelope means the relay needs zero new client-side
parsing — it already flows through `NetiflyClient`'s existing
`handleMessage()`/`on(type, handler)` path. The `netifly.` prefix is
reserved for protocol-level frames; app `Events` maps must not use it.

`type` values `netifly.ack`/`netifly.read`/`netifly.response` are excluded
from auto-ack (§8) — acking a relay frame would ack the wrong id.

## 6. Server-side flow

All three client-originated frame kinds reuse the existing
`netifly:user:<id>` Redis channel and the existing subscribe-on-first-
connection/unsubscribe-on-last-disconnect lifecycle in
[connectionRegistry.ts](../../../packages/core/src/connectionRegistry.ts)
and [redisRouter.ts](../../../packages/core/src/redisRouter.ts) — no new
channel, no change to that lifecycle.

- **Client sends `{ type: 'ack'|'read', id }` or `{ type: 'response', id, payload }`**
  on its socket:
  1. The instance holding that socket (`registerConnection`'s new
     `ws.on('message', ...)` handler) parses and validates the frame
     (§9) and checks the per-connection rate limit (§9).
  2. If valid, it emits `'delivered'`/`'read'`/`'response'` locally
     (`{ userId, id, ts }`, or `{ userId, id, payload, ts }` for
     `'response'`) — **exactly once, on this instance only**, before
     doing anything else.
  3. It then builds a relay envelope (§5) and calls the existing
     `this.router.publish(userId, envelope)` — the same method `send()`
     already uses.
  4. `RedisRouter`'s subscriber callback (`deliverLocally`) forwards the
     relay envelope to every local socket for that user, on every
     subscribed instance, **exactly like it already does for outbound
     notifications** — it does not know or care whether a message is an
     original notification or a relay, and it never fires hooks itself.
     This is what makes exactly-once safe: the hook fires synchronously in
     step 2, on the receiving instance, before publish; the Redis fan-out
     in step 4 only ever forwards to sockets.

- **`send(userId, ...)` / `sendOr(userId, ...)`** (on both `NetiflyInstance`
  and `NetiflyPublisher`):
  1. `validate` hook runs (existing behavior) — a throw aborts before
     anything below.
  2. Envelope is built (existing `buildEnvelope`).
  3. Emit `'sent'` locally: `{ userId, id, type, data }` — synchronous,
     before the publish, so a listener can persist a "pending" record
     before delivery is even attempted.
  4. Publish + return `SendResult`, unchanged from today.

**Accepted behavior**: the client whose ack/read/response triggered the
relay also receives the relayed frame back on its own socket — an echo of
its own action, on the `netifly.*` channel it can choose to ignore or use
to update local UI. Not deduplicated, same rationale as NOT-41 §6.

## 7. Public API (`@netiflyjs/core`)

```ts
interface CreateNetiflyOptions<Events> {
  // ...existing options unchanged...
  /**
   * Max inbound client frames (ack/read/response) accepted per connection,
   * per second, via a simple per-connection token bucket. Frames beyond the
   * limit are dropped and counted via 'malformedFrame' (reason:
   * 'rateLimited') rather than closing the connection. Defaults to 20.
   */
  maxInboundFramesPerSecond?: number;
}

interface NetiflyInstance<Events> {
  // ...existing send/sendOr/disconnect/isOnline/etc. unchanged...

  on(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  on(event: 'sent', listener: (info: { userId: UserId; id: string; type: string; data: unknown }) => void): this;
  on(event: 'delivered' | 'read', listener: (info: { userId: UserId; id: string; ts: number }) => void): this;
  on(event: 'response', listener: (info: { userId: UserId; id: string; payload: unknown; ts: number }) => void): this;
  on(event: 'malformedFrame', listener: (info: { userId: UserId; reason: 'invalidJson' | 'invalidShape' | 'rateLimited' }) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'reject', listener: (info: RejectInfo) => void): this;
  on(event: 'dropped', listener: (info: DroppedInfo) => void): this;
  once(...): this; // mirrors on() for every event above, as today
}

interface NetiflyPublisher<Events> {
  // ...existing send/isOnline/etc. unchanged...
  on(event: 'sent', listener: (info: { userId: UserId; id: string; type: string; data: unknown }) => void): this;
  once(event: 'sent', listener: (...) => void): this;
}
```

Usage:

```ts
netifly.on('sent', ({ userId, id, type, data }) => {
  db.notifications.insert({ id, userId, type, data, status: 'sent' });
});

netifly.on('delivered', ({ id }) => {
  db.notifications.update(id, { status: 'delivered' });
});

netifly.on('read', ({ id }) => {
  db.notifications.update(id, { status: 'read' });
});

netifly.on('response', ({ id, payload }) => {
  db.notifications.update(id, { status: 'responded', response: payload });
});

netifly.on('malformedFrame', ({ userId, reason }) => {
  metrics.increment('netifly.malformed_frame', { reason });
});
```

## 8. Client-side API (`@netiflyjs/client`)

```ts
interface NetiflyClientOptions {
  // ...existing options unchanged...
  /** Auto-send { type: 'ack', id } on receipt of every application envelope. Defaults to true. */
  autoAck?: boolean;
}

class NetiflyClient<Events> {
  // ...existing methods unchanged...

  /** Sends { type: 'read', id }. No-op if not connected. */
  markRead(id: string): void;

  /** Sends { type: 'response', id, payload }. No-op if not connected. */
  respond(id: string, payload: unknown): void;
}
```

- Auto-ack: after dispatching an envelope's handlers in `handleMessage()`,
  the client sends `{ type: 'ack', id: envelope.id }` unless
  `autoAck: false` was passed, **and** unless `envelope.type` starts with
  `netifly.` (relay frames are never auto-acked — see §5).
- `markRead`/`respond` are silent no-ops when the socket isn't open
  (matches the client's current total lack of an outbound queue — an ack
  lost during a disconnect window is treated the same as any other
  in-flight message during an outage).
- Both go through one small private `send(frame)` helper wrapping
  `socket.send(JSON.stringify(frame))`, staying inside the package's
  existing 3 KB gzip budget ([package.json](../../../packages/client/package.json)).

## 9. Error handling

- A throwing/rejecting `'sent'`, `'delivered'`, `'read'`, `'response'`,
  or `'malformedFrame'` listener is caught and reported via the existing
  `emitError` path — it never blocks `send()`, the relay, or any other
  listener.
- `'malformedFrame'` is emitted unconditionally (like the existing
  `'dropped'` event, not gated by listener count like `'error'`) whenever
  an inbound frame is:
  - not valid JSON (`reason: 'invalidJson'`),
  - not `{ type: 'ack'|'read', id: string }` or
    `{ type: 'response', id: string, payload: <present> }`
    (`reason: 'invalidShape'`), or
  - over the per-connection rate limit (`reason: 'rateLimited'`).

  In every case the frame is dropped, the connection stays open, and
  nothing crashes. Frame size itself is already bounded by the existing
  `maxPayload` option (enforced by `ws` at the WebSocket layer — a
  `response` with a large `payload` may need the app to raise it).
- All other error handling from the v1 design (§11 of
  [2026-09-24-netifly-design.md](./2026-09-24-netifly-design.md)) is
  unchanged.

## 10. Testing

- `netiflyServer.test.ts`: real WS round-trips —
  - a client sends `ack`/`read`/`response`; assert the corresponding hook
    fires exactly once (not once per subscribed instance) with the
    correct payload;
  - a second connection for the same user (another tab, another instance)
    receives the `netifly.ack`/`netifly.read`/`netifly.response` relay
    envelope, including the originating connection itself (echo);
  - `send()`/`sendOr()` fire `'sent'` synchronously with the generated id,
    on both a `NetiflyInstance` and a `NetiflyPublisher`;
  - malformed frames (bad JSON, wrong shape, unknown `type`) never crash
    and fire `'malformedFrame'` with the right `reason`, connection stays
    open and otherwise functional;
  - frames beyond `maxInboundFramesPerSecond` are dropped and counted,
    connection stays open.
- `client.test.ts`: `markRead`/`respond` send the right frame when open
  and no-op when not connected; auto-ack fires by default and is
  suppressed by `autoAck: false`; auto-ack does not fire for `netifly.*`
  relay envelopes.
- `redisRouter.test.ts`: unaffected — relay envelopes flow through the
  same `publish`/`onMessage` path already tested for notifications, no new
  channel logic to cover there.
- Existing `connectionRegistry.test.ts` and `heartbeat.test.ts` are
  unaffected.

## 11. Migration notes (for CHANGELOG / release)

- Non-breaking, additive minor-version bump for `@netiflyjs/core` and
  `@netiflyjs/client` (and `@netiflyjs/express`, which re-exports core's
  types).
- README gets a new section documenting `'sent'`/`'delivered'`/`'read'`/
  `'response'`/`'malformedFrame'` next to the existing
  `'connect'`/`'disconnect'`/`'error'`/`'reject'`/`'dropped'`
  documentation, `maxInboundFramesPerSecond`, and client-side
  `markRead()`/`respond()`/`autoAck` usage, including the reserved
  `netifly.` type-namespace note.
- Recommend closing NOT-41 as superseded (§2) once this ships.
