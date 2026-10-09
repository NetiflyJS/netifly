# `@netiflyjs/react` reference

A provider and three hooks on top of [`@netiflyjs/client`](client.md).
Without this package, every React adopter wires the client into effects by
hand: one socket per app, subscribe/cleanup, a list of notifications, an
unread count — easy to get subtly wrong, especially under StrictMode's
double-invoked effects.

```tsx
import { NetiflyProvider, useEvent, useNotifications } from '@netiflyjs/react';

type Events = {
  'comment.created': { commentId: string };
};

function App() {
  return (
    <NetiflyProvider url="wss://api.example.com/netifly" getToken={() => session.accessToken}>
      <Inbox />
    </NetiflyProvider>
  );
}
```

## `<NetiflyProvider>`

Same `options` as [`createNetiflyClient`](client.md#createnetiflyclienteventsoptions),
passed as props. Creates and owns a single `NetiflyClient`, connecting on
mount and closing on unmount. Everything below reads from it via context.

The client is created inside a lazy `useState` initializer rather than an
effect, so under React 18 StrictMode's dev-only double-invoke — which
calls that initializer twice, then runs the mount effect, its cleanup, and
the mount effect again — only one `NetiflyClient` instance is ever kept;
the discarded one from the extra initializer call never gets attached to
an effect, so it never calls `connect()` and is simply garbage. That one
real client still sees its own connect → close → connect churn from the
synthetic remount, same as any effect with StrictMode on — by design, not
a double connection, since the first socket is fully closed before the
second opens.

No socket is ever opened outside that effect, so constructing the tree
during SSR (`renderToString`, `renderToPipeableStream`) is always
socket-free — safe to import in Next.js (App Router or Pages) with no
`typeof window` guards.

`url`, `tokenMode`, and the other `NetiflyClientOptions` props are read
once, at the moment the client is constructed — changing them on a later
render does not reconnect or recreate the client. `getToken` is the one
exception: it's re-read from a ref on every (re)connect attempt, so a
token obtained from a later render (e.g. right after your app refreshes
it) is what the *next* reconnect actually presents, not the closure that
was captured when `<NetiflyProvider>` first mounted.

## `useNetifly<Events>()`

Returns `{ client: NetiflyClient<Events>, status: ConnectionState }`.
Throws `Error('useNetifly() must be used within a <NetiflyProvider>')`
outside the provider.

## `useEvent<Events, K>(type, handler)`

```ts
useEvent<Events, 'comment.created'>('comment.created', (data) => toast(`New comment: ${data.commentId}`));
```

Subscribes to one application event, same as `client.on()`. Takes both
type arguments explicitly, since (unlike `client.on()`) it isn't bound to
an already-typed client instance. Keeps `handler` in a ref and only
resubscribes when `type` (or the client) changes — passing a new inline
closure on every render never tears down and recreates the subscription,
and the *latest* handler is always the one invoked. Unsubscribes on
unmount.

## `useNotifications<Events>()`

Reads a small in-memory store, one per `<NetiflyProvider>`, shared by
every component that calls the hook (via `useSyncExternalStore`, so it's
safe under concurrent rendering and never tears). Returns:

| Field | Description |
| --- | --- |
| `items: NotificationItem[]` | Newest first; `{ id, receivedAt, status, notification }` where `status` is `'unread' \| 'read' \| 'answered' \| 'expired'` and `notification` is the `WireNotification` from `@netiflyjs/client`. |
| `unreadCount: number` | |
| `markRead(id): void` / `markAllRead(): void` | Send `markRead()` to the server and flip local status. |
| `dismiss(id): void` | Removes the item locally only — there's no wire frame for "dismiss," so nothing round-trips to the server. |
| `respond(notificationId, actionId, input?): Promise<'accepted' \| 'already_answered' \| 'expired' \| 'invalid'>` | Looks up the action's signed token from the stored notification and calls `client.respondToAction()`, resolving once the matching `netifly.actionAck` arrives (or immediately with `'invalid'` if the notification/action isn't known locally). Kept as a hook-level convenience rather than a `NetiflyClient` method on purpose: a 3-argument shape here would otherwise collide with the already-shipped, unrelated `client.respond(id, payload)`. |

An item also updates to `'expired'` on its own, client-side, once its
`expiresAt` passes (no server round trip needed), and to `'answered'` when
`netifly.notification.resolved` arrives — covering the case where the user
answered it from a different tab or device.

See the [recipe on building a notification inbox](../recipes/react-notification-inbox.md)
for a full worked example, and the runnable
[`examples/react`](https://github.com/NetiflyJS/netifly/tree/main/examples/react)
app.

`react` (`^18.0.0 || ^19.0.0`) is a peer dependency; no other runtime
dependency beyond `@netiflyjs/client`.

## All exports

Every name `@netiflyjs/react` exports from its package entry point.

**Functions**

| Export | Description |
| --- | --- |
| `NetiflyProvider` | See [`<NetiflyProvider>`](#netiflyprovider). |
| `useNetifly` | See [`useNetifly<Events>()`](#usenetiflyevents). |
| `useEvent` | See [`useEvent<Events, K>(type, handler)`](#useeventevents-ktype-handler). |
| `useNotifications` | See [`useNotifications<Events>()`](#usenotificationsevents). |

**Types**

| Export | Description |
| --- | --- |
| `NetiflyProviderProps` | `NetiflyClientOptions & { children: ReactNode }` — every `<NetiflyProvider>` prop. |
| `NetiflyContextValue<Events>` | `{ client: NetiflyClient<Events>, status: ConnectionState, store }` — what `useNetifly()` reads from context (`status`/`client` are the public surface; `useNetifly()` omits `store`). |
| `UseNotificationsResult` | The return type of `useNotifications()` — see the [table above](#usenotificationsevents). |
| `NotificationItem` | `{ id, receivedAt, status, notification }` — one entry of `useNotifications()`'s `items`. |
| `NotificationStatus` | `'unread' \| 'read' \| 'answered' \| 'expired'` — `NotificationItem.status`. |
| `RespondResult` | `'accepted' \| 'already_answered' \| 'expired' \| 'invalid'` — what `respond()` resolves to. |

## See also

- [Getting started](../getting-started.md)
- [Recipe: building a notification inbox](../recipes/react-notification-inbox.md)
- [`client` reference](client.md) · [`core` reference](core.md) · [`express` reference](express.md)
