# Hooks: backend and frontend

Netifly exposes two independent sets of lifecycle hooks — the server's
`on(event, handler)` on a `NetiflyInstance`/`NetiflyPublisher`, and the
client's `onX()` methods plus React's hooks on top of those. They're not
mirror images of each other: most backend hooks fire from a raw client
frame arriving, and most frontend hooks fire from a server-relayed
envelope arriving. This page is the map between them; full option/payload
detail lives in the [`core`](../reference/core.md) and
[`client`](../reference/client.md) references.

## Backend hooks (`NetiflyInstance.on(...)`)

| Event | Fires when | Payload |
| --- | --- | --- |
| `connect` / `disconnect` | A user's first connection opens / last one closes, on this instance | `userId` |
| `sent` | Synchronously inside `send()`/`sendOr()`/`notify()`/`notifyOr()`, before publishing | `SentInfo` — `{ userId, id, type, data }` |
| `delivered` / `read` | A client sends `{ type: 'ack' \| 'read', id }` | `AckInfo` — `{ userId, id, ts }` |
| `response` | A client sends `{ type: 'response', id, payload }` | `ResponseInfo` — `{ userId, id, payload, ts }` |
| `action` | A client answers a `kind: 'action'` notification | `ActionInfo` — `{ userId, notificationId, actionId, input?, context? }` |
| `reject` | An upgrade is rejected before a connection is established | `RejectInfo` — origin/`maxConnectionsPerUser`/auth, see [`core` reference](../reference/core.md#createnetiflyeventsoptions) |
| `dropped` | A queued delivery is skipped for a stalled connection | `DroppedInfo` — `{ userId, reason: 'maxBufferedBytes' }` |
| `malformedFrame` | An inbound client frame is invalid rather than crashing the connection | `MalformedFrameInfo` — `{ userId, reason }` |
| `error` | Anything the transport or a hook listener itself throws | `Error` — **attach this one**; see below |

`sent`/`delivered`/`read`/`response` are the four this page cares about
most — they're the hooks a persistence layer hangs off (see
[Persistence](persistence.md)). `action` is the fifth, specific to
two-way notifications (see
[Publishing patterns](publishing-patterns.md#two-way-actionable-notifications)).

> ⚠️ **Attaching an `'error'` listener is effectively required in
> production.** Netifly never throws into your host process — an
> unhandled `'error'` emit with zero listeners crashes it instead. Without
> one attached, transport/Redis failures are completely invisible.

`NetiflyPublisher` (the worker/serverless counterpart — see
[Publishing patterns](publishing-patterns.md)) only has `sent`, since it
never holds a live connection to receive anything back from.

## Frontend hooks (`NetiflyClient` / `@netiflyjs/client`)

| Method | Fires when |
| --- | --- |
| `on(type, handler)` / `onAny(handler)` | An application envelope (or any envelope, for `onAny`) arrives |
| `onNotification(handler)` | Specifically a `notify()`-sent envelope (`type: "notification"`) |
| `onStateChange(handler)` | Connection lifecycle: `connecting` → `open` → `reconnecting` → `closed` |
| `onClose(handler)` | The raw WebSocket close event |
| `onError(handler)` | A rejected `getToken()`, an unparseable message, a throwing handler, or giving up after `maxReconnectAttempts` |
| `onActionAck(handler)` | The server's direct reply to `respondToAction()` |
| `onResolved(handler)` | `netifly.notification.resolved` — an actionable notification answered, relayed to every one of the user's connections |

And the methods that *send* something back, each triggering one of the
backend hooks above:

| Method | Triggers backend event |
| --- | --- |
| `markRead(id)` | `'read'` |
| `respond(id, payload)` | `'response'` |
| `respondToAction(id, action, token, input?)` | `'action'` |
| *(nothing — `autoAck`, default on)* | `'delivered'`, automatically on receipt of every application envelope |

## React hooks (`@netiflyjs/react`)

These don't add new events — they're a convenience layer reading the same
`NetiflyClient` methods above through React's rendering model:

- `useNetifly()` → `{ client, status }`, i.e. `onStateChange` as state.
- `useEvent(type, handler)` → `client.on(type, handler)`, subscribed/unsubscribed for you.
- `useNotifications()` → `onNotification` + `markRead` + `respond` + `respondToAction`, bundled into one in-memory store (`items`, `unreadCount`, etc.) — see [Persistence](persistence.md) for why "in-memory" matters.

## One request, both sides: a plain event

```
BE  netifly.send(userId, 'export.ready', { url })
BE  → 'sent' fires synchronously: { userId, id, type: 'export.ready', data }
    → envelope published to Redis, delivered to every open connection
FE  → client.on('export.ready', handler) fires with { url }
FE  → autoAck (default on) sends { type: 'ack', id } back immediately
BE  → 'delivered' fires: { userId, id, ts }
    → relayed to the user's other tabs/devices as a netifly.ack envelope
```

## One request, both sides: a two-way (actionable) notification

```
BE  netifly.notify(userId, { kind: 'action', title, body, actions, expiresAt })
BE  → 'sent' fires, then the envelope is delivered (type: "notification")
FE  → onNotification(handler) fires; UI renders the action buttons
FE  → user clicks one → client.respondToAction(id, actionId, token)
BE  → verifies the signed token, then 'action' fires: { userId, notificationId, actionId, context }
BE  → answering connection gets netifly.actionAck ({ status: 'accepted' })
    → every connection gets netifly.notification.resolved ({ id, action })
FE  → onActionAck(handler) on the answering tab, onResolved(handler) on all tabs
```

See [Publishing patterns](publishing-patterns.md) for when to reach for
each shape, and [Persistence](persistence.md) for turning these hooks into
an actual stored record.
