<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">netifly</h1>

Framework-agnostic, real-time per-user notifications for Node.js servers — WebSockets in, Redis pub/sub for horizontal scaling.

[![npm version](https://img.shields.io/npm/v/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/core.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)

## ✨ Features

- 🔌 **Framework-agnostic core** — attaches to any Node `http.Server`, so it works under Express, Fastify, Koa, NestJS, or raw `http`.
- ⚡ **Express adapter** (`@netiflyjs/express`) for a one-line setup.
- 🔁 **Horizontally scalable** — any number of server instances stay in sync through Redis pub/sub, no sticky sessions required.
- 🔐 **Auth-agnostic** — you supply a `resolveUserId` function; Netifly doesn't care how you authenticate.
- 💓 **Dead-connection reaping** — a ping/pong heartbeat terminates clients that silently disappeared.
- 🧩 **Zero opinions on payload shape** — send whatever JSON-serializable data your app needs.
- ✉️ **Stable message envelope** — every message is wrapped in a small `{ v, id, type, data, ts }` envelope with a server-generated, sortable id.

## 📦 Installation

```bash
npm install @netiflyjs/core
# or, for Express apps:
npm install @netiflyjs/core @netiflyjs/express
```

## 🚀 Quickstart

### Plain Node `http`

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

### Express

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

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware entirely, so `resolveUserId` always receives the raw Node `IncomingMessage`, not an Express `Request`.

> 🛡️ **Security:** WebSocket handshakes are not subject to the same-origin policy and browsers DO send cookies cross-origin on the upgrade request. If your `resolveUserId` derives identity from a cookie-based session, add an `Origin` check inside `resolveUserId` to prevent cross-site WebSocket hijacking, e.g.:
> ```ts
> const ALLOWED_ORIGINS = new Set(['https://app.example.com']);
> resolveUserId: async (req) => {
>   if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return null;
>   return verifyJwtFromRequest(req);
> }
> ```

## 🔐 Redis Configuration

Netifly requires a Redis connection string — never hardcode credentials. Provide it either as an environment variable:

```bash
REDIS_URL=redis://:password@host:6379/0
# or with TLS:
REDIS_URL=rediss://user:password@host:6380/0
```

or explicitly via the `redisUrl` option to `createNetifly()`/`attachNetifly()`, which takes priority over the env var. There is **no default/fallback connection** — if neither `redisUrl` nor `REDIS_URL` is provided, `createNetifly()`/`attachNetifly()` throws a clear error immediately rather than silently connecting to a local Redis instance.

## ✉️ Message Envelope

This is a **public wire contract**: every message Netifly delivers over the WebSocket — regardless of which `send()` overload produced it — is wrapped in this envelope:

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
| `v` | `number` | Envelope format version. Currently always `1`. Lets the wire format evolve without breaking existing consumers. |
| `id` | `string` | A server-generated [ULID](https://github.com/ulid/spec) — lexicographically sortable by creation time, useful for dedupe and future replay (`lastEventId`). Guaranteed unique and strictly increasing for sends issued by the same server instance, including multiple sends within the same millisecond. Ordering is **not** guaranteed across different server instances in a cluster, since each instance generates its own ids. |
| `type` | `string` | The event name. Set explicitly via `send(userId, type, data)`, or defaults to `"message"` when using `send(userId, payload)`. |
| `data` | `T` | Your payload, whatever JSON-serializable shape it is. |
| `ts` | `number` | Server timestamp (`Date.now()`) at the moment the envelope was created, in epoch milliseconds. |

Non-Node publishers (e.g. publishing directly to a Netifly Redis channel from another language) should produce messages in this exact shape so clients can parse them consistently.

## 📖 API Reference

### `createNetifly(options)` — `@netiflyjs/core`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `server` | `http.Server` | ✅ | The server to attach the WebSocket upgrade handler to. |
| `resolveUserId` | `(req) => string \| null \| undefined \| Promise<...>` | ✅ | Identifies the connecting user. Returning a falsy value rejects the connection. |
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL` if omitted. One of the two **must** be provided — Netifly throws at construction time if neither is set (no default/local fallback). |
| `path` | `string` | — | WebSocket upgrade path. Defaults to `/netifly`. |

Returns a `NetiflyInstance`:

- `send<T>(userId, payload: T): Promise<void>` — wraps `payload` as `{ v, id, type: "message", data: payload, ts }` (see [Message Envelope](#message-envelope)) and delivers it to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere.
- `send<T>(userId, type: string, data: T): Promise<void>` — same delivery semantics, but wraps as `{ v, id, type, data, ts }` with the `type` you provide instead of the `"message"` default.
- `disconnect(userId): void` — **known limitation: this only closes connections on the local instance.** In a multi-instance deployment, a user may still be connected on other instances after calling this. It is not a cluster-wide "force logout." Workarounds: call `disconnect(userId)` on every instance (e.g. via a pub/sub broadcast of your own), or prefer short-lived auth tokens that `resolveUserId` rejects once revoked, so stale connections are cut off the next time they'd need to reconnect/re-authenticate.
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`. **Attaching an `'error'` listener is effectively required for production use** — Netifly never throws into the host process (an unhandled `'error'` emit with no listener would crash it), so without a listener attached, Redis/connection failures are completely invisible.
- `close(): Promise<void>` — graceful shutdown: stops the heartbeat, closes the WS server, and closes both Redis connections.

### `attachNetifly(app, options)` — `@netiflyjs/express`

Same `options` as `createNetifly`, minus `server` (optional — pass your own, or let it create one from the Express app). Returns `{ server, netifly }`.

## 🏗️ Architecture

```
Client A ──WS──► Server Instance 1 ──┐
Client B ──WS──► Server Instance 2 ──┼──► Redis (pub/sub, per-user channels)
Client C ──WS──► Server Instance 3 ──┘
```

Each instance subscribes to a user's Redis channel (`netifly:user:<id>`) only while it holds a live connection for that user, and unsubscribes the moment that user disconnects locally — so `send()` traffic only reaches the instance(s) that actually need it.

## 🧪 Testing & Development

This is a pnpm workspace monorepo.

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
pnpm test
pnpm build
```

## 🤝 Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide each package's next version and changelog automatically on merge to `main`.

## 📄 License

[MIT](./LICENSE)
