# Getting Started

## Installation

```bash
npm install @netiflyjs/core
# or, for Express apps:
npm install @netiflyjs/core @netiflyjs/express
# and, in your frontend (or any WebSocket client):
npm install @netiflyjs/client
```

## Redis

Netifly requires a Redis connection string — there is no default/local
fallback. Provide it as an environment variable:

```bash
REDIS_URL=redis://:password@host:6379/0
# or with TLS:
REDIS_URL=rediss://user:password@host:6380/0
```

or explicitly via the `redisUrl` option to `createNetifly()` /
`attachNetifly()`, which takes priority over the env var. If neither is set,
`createNetifly()` throws immediately rather than silently connecting to a
local Redis instance.

> Sharing one Redis instance across apps or environments (e.g. a free-tier
> Upstash/Redis Cloud instance shared between staging and prod)? Set
> `namespace` so per-user channel names don't collide — see the
> [`core` reference](reference/core.md).

## Plain Node `http`

```ts
import http from 'node:http';
import { createNetifly } from '@netiflyjs/core';

const server = http.createServer((req, res) => res.end('ok'));

const netifly = createNetifly({
  server,
  resolveUserId: async (req) => verifyJwtFromRequest(req), // your own auth
});

server.listen(3000);

// Anywhere in your app:
netifly.send(userId, 'comment.created', { commentId: 42 });
```

## Express

```ts
import express from 'express';
import { attachNetifly } from '@netiflyjs/express';

const app = express();

const { server, netifly } = attachNetifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  netifly.send(comment.authorId, 'comment.created', comment);
  res.status(201).json(comment);
});

server.listen(3000);
```

`attachNetifly` also mounts a middleware that exposes the same instance as
`req.netifly` on every request, so route handlers defined elsewhere in your
app don't need the closed-over `netifly` variable threaded through:

```ts
app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  req.netifly.send(comment.authorId, 'comment.created', comment); // same instance, via req
  res.status(201).json(comment);
});
```

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware entirely,
> so `resolveUserId` always receives the raw Node `IncomingMessage`, never an
> Express `Request`.
>
> 🛡️ Netifly rejects cross-origin upgrades by default — see
> [Security](security.md) — configure `allowedOrigins` if you need to accept
> them.

## Client SDK

```ts
import { createNetiflyClient } from '@netiflyjs/client';

const client = createNetiflyClient({
  url: 'wss://api.example.com/netifly',
  getToken: () => session.accessToken, // may be async; called on every (re)connect
});

client.on('comment.created', (data) => {
  addCommentToUi(data);
});

client.onStateChange((state) => {
  // 'connecting' | 'open' | 'reconnecting' | 'closed'
  setBanner(state === 'open' ? null : 'Reconnecting…');
});

client.connect();

// …later, on logout/unmount:
client.close(); // cancels any pending reconnect; never reconnects on its own
```

The client handles reconnect (exponential backoff with full jitter) and
token refresh (`getToken` is called again before every attempt) for you —
see the [`client` reference](reference/client.md) for the full reconnect
behavior table, or
[Handling reconnects and token refresh](recipes/client-reconnects-and-token-refresh.md)
for a worked example.

## React

```tsx
import { NetiflyProvider, useEvent, useNotifications } from '@netiflyjs/react';

function App() {
  return (
    <NetiflyProvider url="wss://api.example.com/netifly" getToken={() => session.accessToken}>
      <Inbox />
    </NetiflyProvider>
  );
}

function Inbox() {
  useEvent('comment.created', (data) => toast(`New comment: ${data.commentId}`));
  const { items, unreadCount, markRead } = useNotifications();

  return (
    <>
      <span>{unreadCount} unread</span>
      {items.map((item) => (
        <article key={item.id}>
          <strong>{item.notification.title}</strong>
          <button onClick={() => markRead(item.id)}>Mark read</button>
        </article>
      ))}
    </>
  );
}
```

`<NetiflyProvider>` owns a single `NetiflyClient`, connecting on mount and
closing on unmount — StrictMode-safe and SSR-safe. See the
[`react` reference](reference/react.md) for `useNetifly`/`useEvent`/
`useNotifications` in full, or
[Building a notification inbox](recipes/react-notification-inbox.md) for a
worked example.

## Typed events

Give `createNetifly()` an `Events` map — event name → payload shape — and
`send()`/`sendOr()` become type-checked against it. Share the same map with
the client for typed handlers on the receiving end:

```ts
type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

// Server
const netifly = createNetifly<Events>({ server, resolveUserId });
netifly.send(userId, 'export.ready', { url }); // ✅ type-checked

// Client
const client = createNetiflyClient<Events>({ url, getToken });
client.on('export.ready', ({ url }) => { /* url: string */ });
```

For runtime enforcement (e.g. with [Zod](https://zod.dev)), pass a
`validate` function to `createNetifly()` — see the
[`core` reference](reference/core.md).

## Sending from workers or other languages

Most notifications don't originate in the process holding the WebSocket
server — a BullMQ worker, a cron job, a serverless function. See
[Notifying from a BullMQ worker](recipes/notify-from-a-bullmq-worker.md) for
the `createNetiflyPublisher()` pattern, or publish directly to Netifly's Redis
wire protocol from any language — details in the
[`core` reference](reference/core.md).
