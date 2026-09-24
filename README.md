# 🔔 Notifly

Framework-agnostic, real-time per-user notifications for Node.js servers — WebSockets in, Redis pub/sub for horizontal scaling.

[![npm version](https://img.shields.io/npm/v/@notifly/core.svg)](https://www.npmjs.com/package/@notifly/core)
[![CI](https://github.com/NotiflyJS/notifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NotiflyJS/notifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@notifly/core.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@notifly/core.svg)](https://www.npmjs.com/package/@notifly/core)

## ✨ Features

- 🔌 **Framework-agnostic core** — attaches to any Node `http.Server`, so it works under Express, Fastify, Koa, NestJS, or raw `http`.
- ⚡ **Express adapter** (`@notifly/express`) for a one-line setup.
- 🔁 **Horizontally scalable** — any number of server instances stay in sync through Redis pub/sub, no sticky sessions required.
- 🔐 **Auth-agnostic** — you supply a `resolveUserId` function; Notifly doesn't care how you authenticate.
- 💓 **Dead-connection reaping** — a ping/pong heartbeat terminates clients that silently disappeared.
- 🧩 **Zero opinions on payload shape** — send whatever JSON-serializable data your app needs.

## 📦 Installation

```bash
npm install @notifly/core
# or, for Express apps:
npm install @notifly/core @notifly/express
```

## 🚀 Quickstart

### Plain Node `http`

```ts
import http from 'node:http';
import { createNotifly } from '@notifly/core';

const server = http.createServer((req, res) => res.end('ok'));

const notifly = createNotifly({
  server,
  resolveUserId: async (req) => verifyJwtFromRequest(req), // your own auth
});

server.listen(3000);

// Anywhere in your app:
notifly.send(userId, { type: 'comment.created', payload: { commentId: 42 } });
```

### Express

```ts
import express from 'express';
import { attachNotifly } from '@notifly/express';

const app = express();

const { server, notifly } = attachNotifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  notifly.send(comment.authorId, { type: 'comment.created', payload: comment });
  res.status(201).json(comment);
});

server.listen(3000);
```

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware entirely, so `resolveUserId` always receives the raw Node `IncomingMessage`, not an Express `Request`.

## 🔐 Redis Configuration

Notifly reads a single `REDIS_URL` environment variable — never hardcode credentials:

```bash
REDIS_URL=redis://:password@host:6379/0
# or with TLS:
REDIS_URL=rediss://user:password@host:6380/0
```

You can also pass `redisUrl` explicitly to `createNotifly()`/`attachNotifly()`, which takes priority over the env var.

## 📖 API Reference

### `createNotifly(options)` — `@notifly/core`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `server` | `http.Server` | ✅ | The server to attach the WebSocket upgrade handler to. |
| `resolveUserId` | `(req) => string \| null \| undefined \| Promise<...>` | ✅ | Identifies the connecting user. Returning a falsy value rejects the connection. |
| `redisUrl` | `string` | — | Defaults to `process.env.REDIS_URL`. |
| `path` | `string` | — | WebSocket upgrade path. Defaults to `/notifly`. |

Returns a `NotiflyInstance`:

- `send(userId, payload): Promise<void>` — delivers `payload` to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere.
- `disconnect(userId): void` — force-closes all of a user's local connections (e.g. on logout).
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`.
- `close(): Promise<void>` — graceful shutdown: stops the heartbeat, closes the WS server, and closes both Redis connections.

### `attachNotifly(app, options)` — `@notifly/express`

Same `options` as `createNotifly`, minus `server` (optional — pass your own, or let it create one from the Express app). Returns `{ server, notifly }`.

## 🏗️ Architecture

```
Client A ──WS──► Server Instance 1 ──┐
Client B ──WS──► Server Instance 2 ──┼──► Redis (pub/sub, per-user channels)
Client C ──WS──► Server Instance 3 ──┘
```

Each instance subscribes to a user's Redis channel (`notifly:user:<id>`) only while it holds a live connection for that user, and unsubscribes the moment that user disconnects locally — so `send()` traffic only reaches the instance(s) that actually need it.

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
