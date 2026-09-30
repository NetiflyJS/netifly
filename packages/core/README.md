<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/netifly-mark-on-dark.svg">
    <img src="assets/brand/netifly-mark.svg" alt="Netifly" width="96">
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
netifly.send(userId, { type: 'comment.created', payload: { commentId: 42 } });
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
  netifly.send(comment.authorId, { type: 'comment.created', payload: comment });
  res.status(201).json(comment);
});

server.listen(3000);
```

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware entirely, so `resolveUserId` always receives the raw Node `IncomingMessage`, not an Express `Request`.

> 🛡️ **Security:** WebSocket handshakes are not subject to the same-origin policy, and browsers DO send cookies cross-origin on the upgrade request — this is what enables cross-site WebSocket hijacking (CSWSH) when `resolveUserId` derives identity from a cookie-based session. Netifly checks `Origin` against the request's `Host` by default and rejects mismatches with `403` before `resolveUserId` runs; pass `allowedOrigins` to customize or opt out. See the [root README's Security section](https://github.com/NetiflyJS/netifly#-security) for details.

## 🔐 Redis Configuration

Netifly requires a Redis connection string — never hardcode credentials. Provide it either as an environment variable:

```bash
REDIS_URL=redis://:password@host:6379/0
# or with TLS:
REDIS_URL=rediss://user:password@host:6380/0
```

or explicitly via the `redisUrl` option to `createNetifly()`/`attachNetifly()`, which takes priority over the env var. There is **no default/fallback connection** — if neither `redisUrl` nor `REDIS_URL` is provided, `createNetifly()`/`attachNetifly()` throws a clear error immediately rather than silently connecting to a local Redis instance.

## 📖 API Reference

### `createNetifly(options)` — `@netiflyjs/core`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `server` | `http.Server` | ✅ | The server to attach the WebSocket upgrade handler to. |
| `resolveUserId` | `(req) => string \| null \| undefined \| Promise<...>` | ✅ | Identifies the connecting user. Returning a falsy value rejects the connection. |
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL` if omitted. One of the two **must** be provided — Netifly throws at construction time if neither is set (no default/local fallback). |
| `path` | `string` | — | WebSocket upgrade path. Defaults to `/netifly`. |
| `allowedOrigins` | `(string \| RegExp)[] \| ((origin) => boolean) \| '*'` | — | Defaults to same-host only. See [Security](https://github.com/NetiflyJS/netifly#-security). |
| `maxInboundFramesPerSecond` | `number` | — | Max inbound client frames (ack/read/response) accepted per connection, per second. Frames beyond the limit are dropped and counted via `'malformedFrame'` (reason `'rateLimited'`) rather than closing the connection. Defaults to `20`. |

Returns a `NetiflyInstance`:

- `send(userId, payload): Promise<void>` — delivers `payload` to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere.
- `notify(userId, notification): Promise<SendResult>` — validated, opinionated notification API (`{ kind: 'info', title, body, severity?, link?, icon?, expiresAt?, meta? }`) built on `send()`. See the [full README](https://github.com/NetiflyJS/netifly#-api-reference) for validation rules and `notifyOr()`.
- `on('action', ({ userId, notificationId, actionId, input, context }) => void)` — fires when a client answers a `kind: 'action'` notification via a cryptographically verified, signed token. Requires `actionSecret` (or `NETIFLY_SECRET`) — `createNetifly()` throws at construction unless one is set or `actionSecret: false` is passed. See the [full README](https://github.com/NetiflyJS/netifly#actionable-notifications) for the "Actionable notifications" guide.
- `disconnect(userId): void` — **known limitation: this only closes connections on the local instance.** In a multi-instance deployment, a user may still be connected on other instances after calling this. It is not a cluster-wide "force logout." Workarounds: call `disconnect(userId)` on every instance (e.g. via a pub/sub broadcast of your own), or prefer short-lived auth tokens that `resolveUserId` rejects once revoked, so stale connections are cut off the next time they'd need to reconnect/re-authenticate.
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`, `on('reject', ({ reason, status, origin, req }) => void)` — fires when the origin check rejects an upgrade. **Attaching an `'error'` listener is effectively required for production use** — Netifly never throws into the host process (an unhandled `'error'` emit with no listener would crash it), so without a listener attached, Redis/connection failures are completely invisible.
- `on('sent', ({ userId, id, type, data }) => void)` — fires synchronously inside `send()`/`sendOr()` (and on `NetiflyPublisher`, too) with the generated envelope id, before the envelope is published. A place to persist a notification record at send time.
- `on('delivered' | 'read', ({ userId, id, ts }) => void)` — fires when a client sends `{ type: 'ack' | 'read', id }` back over its WebSocket connection, exactly once per client action (never once per server instance). Also relayed to the user's other open connections as a `netifly.ack`/`netifly.read` envelope, for multi-tab/multi-device sync.
- `on('response', ({ userId, id, payload, ts }) => void)` — fires when a client sends `{ type: 'response', id, payload }` with an arbitrary JSON payload (e.g. a reply to an action button). Relayed the same way, as `netifly.response`.
- `on('malformedFrame', ({ userId, reason }) => void)` — fires instead of throwing when an inbound client frame is invalid JSON, the wrong shape, or over `maxInboundFramesPerSecond` (`reason`: `'invalidJson' | 'invalidShape' | 'rateLimited'`). The connection is never closed for this.
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
