# Netifly

**Real-time user notifications for Node, secure by default. Send to a user, not a channel.**

Netifly is a framework-agnostic, real-time per-user notification layer for Node.js
servers — WebSockets in, Redis pub/sub for horizontal scaling. You call
`netifly.send(userId, type, data)` from anywhere in your backend; Netifly finds
every WebSocket connection that user currently holds, anywhere in your cluster,
and delivers to all of them.

## Why Netifly

Most real-time libraries route by room or channel — you manage the mapping from
a user to the channel(s) they should hear from yourself. Netifly routes by user
directly: `send(userId, payload)` is the whole API, and it works the same
whether that user has one connection or ten, on one server or across a fleet.

| | **Netifly** | Socket.IO | Pusher |
| --- | --- | --- | --- |
| Routing model | Per-user | Per-room/channel (you manage the mapping) | Per-channel (you manage the mapping) |
| Infrastructure | Self-hosted, your own Redis | Self-hosted, your own adapter | Third-party hosted service |
| Pricing | Free — you pay for Redis | Free — you pay for infra | Per-message / per-connection billing |
| Data path | Never leaves your infrastructure | Never leaves your infrastructure | Passes through a third party |

Netifly is deliberately narrow: no rooms, no presence, no broadcast — just
"deliver this payload to this user, wherever they're connected." Reach for
Socket.IO if you need room-based fan-out to anonymous clients; reach for Pusher
if a managed service is an acceptable trade for not running your own Redis.

## Packages

- **[`@netiflyjs/core`](reference/core.md)** — the framework-agnostic engine.
  Attaches to any Node `http.Server`.
- **[`@netiflyjs/express`](reference/express.md)** — a thin Express adapter
  over `core`, for one-line setup in an Express app.
- **[`@netiflyjs/client`](reference/client.md)** — the browser/React
  Native/Node client SDK, ~1.7 KB gzipped, with reconnect and typed events
  built in.
- **[`@netiflyjs/react`](reference/react.md)** — a provider and hooks
  (`useNetifly`, `useEvent`, `useNotifications`) on top of the client SDK,
  StrictMode- and SSR-safe.

## Where to go next

- **[Getting started](getting-started.md)** — install, quickstart, and the
  typed-events pattern.
- **[Security](security.md)** — the origin allowlist, cookie vs. token auth,
  and the built-in abuse-vector limits.
- **[Concepts](concepts/README.md)** — the backend/frontend hook lifecycle,
  single/multi-user/two-way publishing patterns, and how persistence
  actually works (Netifly stores nothing — this is the bring-your-own-DB
  guide, plus the current gaps like no replay-on-reconnect).
- **Recipes** — [email when a user is offline](recipes/email-when-offline.md),
  [notifying from a BullMQ worker](recipes/notify-from-a-bullmq-worker.md),
  [handling reconnects and token refresh](recipes/client-reconnects-and-token-refresh.md),
  [building a notification inbox](recipes/react-notification-inbox.md).
- **API reference** — [`core`](reference/core.md),
  [`express`](reference/express.md), [`client`](reference/client.md),
  [`react`](reference/react.md).

Source lives at [github.com/NetiflyJS/netifly](https://github.com/NetiflyJS/netifly),
licensed under [MIT](https://github.com/NetiflyJS/netifly/blob/main/LICENSE).
