# Notifly — Design Spec

**Date:** 2026-09-24
**Status:** Approved for implementation planning
**Author:** dolufemi (with Claude Code)

## 1. Summary

Notifly is an open-source, framework-agnostic Node.js library that lets any
server add real-time, per-user push notifications with minimal setup. A
server-side call like `notifly.send(userId, payload)` delivers the payload
over WebSocket to that user's live connection(s), even when the app is
horizontally scaled across multiple Node processes — coordinated through
Redis pub/sub, following the architecture described in
["Building a Scalable Real-Time Notification System with Node.js, WebSockets, and Redis"](https://medium.com/@govindaekbote7/building-a-scalable-real-time-notification-system-with-node-js-websockets-and-redis-7b706f83de32).

Notifly is a library embedded in the consumer's own server process, not a
standalone service.

## 2. Goals

- Framework-agnostic core: works with any framework built on Node's
  `http.Server` (Express, Fastify, Koa, NestJS, raw `http`, etc.).
- A first-class Express adapter for a smoother DX, as the reference
  implementation of the adapter pattern other frameworks can follow later.
- Horizontal scalability across multiple server instances via Redis
  pub/sub, without requiring sticky sessions.
- Auth-agnostic: Notifly does not implement authentication; the consuming
  app supplies a `resolveUserId` function.
- Redis credentials supplied via environment variable, never hardcoded.
- Publishable, versioned, and released automatically via CI on merge to
  `main`.

## 3. Non-goals (v1)

- Offline/undelivered message persistence or replay. If no server instance
  currently holds a live connection for a user, the notification is
  dropped (fire-and-forget). Apps that need durability can persist
  notifications in their own datastore alongside calling `send()`.
- Delivery acknowledgement / read receipts.
- Broadcast-to-topic or room-based pub/sub (only per-user targeting).
- Adapters for frameworks other than Express (Fastify, Koa, NestJS, etc.
  are future work, following the same adapter pattern).
- A standalone/out-of-process notification server.

## 4. Architecture

```
Client A ──WS──► Server Instance 1 ──┐
Client B ──WS──► Server Instance 2 ──┼──► Redis (pub/sub, per-user channels)
Client C ──WS──► Server Instance 3 ──┘
```

Each server instance embeds a Notifly WebSocket server attached to its own
`http.Server`. Instances do not talk to each other directly — all
cross-instance coordination goes through Redis.

### 4.1 Connection identity

On WebSocket upgrade, Notifly calls the app-supplied `resolveUserId(req)`
to determine which user is connecting. Notifly has no opinion on how that
resolution happens (JWT, session cookie, API key, etc.) — it just needs a
function that returns a `userId` (or throws/returns `null` to reject the
connection). A user may have multiple simultaneous connections (e.g.
multiple tabs/devices); all of them receive each notification sent to
that `userId`.

### 4.2 Redis routing: per-user channels, subscribe-on-demand

Each server instance keeps an in-memory registry:

```
Map<userId, Set<WebSocket>>
```

- **On a user's first local connection** (registry entry goes from absent
  to present), the instance issues `SUBSCRIBE notifly:user:<userId>` on
  its dedicated Redis subscriber connection.
- **On a user's last local disconnect** (registry entry's set becomes
  empty), the instance issues `UNSUBSCRIBE notifly:user:<userId>` and
  removes the entry.
- **`notifly.send(userId, payload)`** always `PUBLISH`es to
  `notifly:user:<userId>` on a separate Redis publisher connection. It
  does not check local state first — publishing is unconditional; Redis
  fan-out reaches whichever instance(s) are currently subscribed.
- When a subscribed instance receives a pub/sub message on
  `notifly:user:<userId>`, it looks up its local registry for that
  `userId` and forwards the payload to every WebSocket connection in the
  set.
- If no instance is subscribed to that channel (user fully offline), the
  `PUBLISH` has zero subscribers and the message is simply dropped — this
  is the intended v1 fire-and-forget behavior, and requires no additional
  code (Redis pub/sub already behaves this way for channels with no
  subscribers).

This avoids the "every instance receives every message" broadcast pattern
in favor of only routing traffic to instances that actually hold a
connection for the target user, at the cost of subscribe/unsubscribe
lifecycle management, which is handled internally by the refcounted
registry above and is not exposed to consumers.

### 4.3 Redis client

`ioredis` is used, with **two separate connections** per server instance:
one dedicated to `SUBSCRIBE`/`UNSUBSCRIBE` (a Redis connection in
subscribe mode cannot issue other commands), and one for `PUBLISH`. Both
are constructed from the same connection string.

### 4.4 Redis auth / configuration

Redis connection details (host, port, username, password, TLS) are
supplied via a **single `REDIS_URL` environment variable**, e.g.:

```
REDIS_URL=redis://:password@host:6379/0
REDIS_URL=rediss://user:password@host:6380/0   # TLS
```

`createNotifly()` defaults to `process.env.REDIS_URL` if no `redisUrl`
option is explicitly passed. No Redis credentials are ever hardcoded,
logged, or committed. This matches how most managed Redis providers
(Upstash, Redis Cloud, Railway, Heroku) hand out credentials.

## 5. Public API (`@notifly/core`)

```ts
import { createNotifly } from '@notifly/core';
import http from 'node:http';

const server = http.createServer(app); // any framework's underlying http.Server

const notifly = createNotifly({
  server,
  resolveUserId: async (req) => verifyJwtFromRequest(req), // app-owned auth
  redisUrl: process.env.REDIS_URL, // optional, defaults to process.env.REDIS_URL
});

// Elsewhere in the app, e.g. inside a route handler:
notifly.send(userId, { type: 'comment.created', payload: { ... } });

// Optional lifecycle hooks:
notifly.on('connect', (userId) => { /* ... */ });
notifly.on('disconnect', (userId) => { /* ... */ });

// Force-close all of a user's connections (e.g. on logout):
notifly.disconnect(userId);

// Graceful teardown (closes WS server + both Redis connections):
await notifly.close();
```

Payload shape is intentionally opaque (`unknown`/generic) — Notifly
transports whatever JSON-serializable payload the app sends; it does not
impose a notification schema.

## 6. `@notifly/express`

A thin adapter for Express apps:

```ts
import express from 'express';
import { attachNotifly } from '@notifly/express';

const app = express();
const { server, notifly } = attachNotifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

app.use((req, res, next) => {
  req.notifly = notifly; // convenience access inside route handlers
  next();
});

server.listen(3000);
```

`attachNotifly` creates the `http.Server` from the Express app (or accepts
an existing one), wires up `@notifly/core` against it, and returns both
the server and the `notifly` instance. It is a documented convenience
wrapper only — it adds no behavior beyond what `@notifly/core` already
provides, keeping the adapter pattern easy for future frameworks to copy.

## 7. Package structure (pnpm workspace monorepo)

```
notifly/
  packages/
    core/                 @notifly/core
      src/
      package.json
    express/               @notifly/express
      src/
      package.json
  .github/
    workflows/
      ci.yml               lint, typecheck, test, build — on PR + push
      release.yml           semantic-release — on push to main
  docs/
    superpowers/specs/      design specs (this file)
  .releaserc.json           semantic-release config (conventional commits)
  pnpm-workspace.yaml
  package.json               workspace root (private)
  tsconfig.base.json
  README.md
  LICENSE                    MIT
```

Both packages are written in TypeScript, compiled to JS + `.d.ts` for
publishing, and published independently under the `@notifly` npm scope
(`@notifly/core`, `@notifly/express`) — the scope is created and owned by
the repo maintainer outside of this codebase.

## 8. Testing

- **Jest** (`ts-jest`) as the test runner across both packages.
- `@notifly/core` unit tests cover: connection registry refcounting
  (subscribe on first connect, unsubscribe on last disconnect), message
  routing (a `send()` reaches only instances/connections registered for
  that `userId`), and Redis interaction — exercised against a real Redis
  (Dockerized service container in CI; documented local Redis requirement
  for running tests locally).
- WebSocket behavior is tested with an in-process `ws` client connecting
  to an ephemeral local server.
- `@notifly/express` tests cover that `attachNotifly` correctly wires the
  Express app's `http.Server` to `@notifly/core` and exposes `req.notifly`.

## 9. CI/CD

### `ci.yml` (PRs and pushes to any branch)
1. Checkout, setup Node + pnpm, `pnpm install --frozen-lockfile`.
2. Spin up a Redis service container.
3. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` across the
   workspace.

### `release.yml` (push to `main` only, after CI passes)
1. Checkout, setup Node + pnpm, `pnpm install --frozen-lockfile`,
   `pnpm build`.
2. Run `semantic-release` (with `@semantic-release/commit-analyzer`,
   `@semantic-release/release-notes-generator`,
   `@semantic-release/changelog`, `@semantic-release/npm`,
   `@semantic-release/git`, `@semantic-release/github`) using
   Conventional Commits to determine version bumps, generate a
   `CHANGELOG.md`, tag the release, publish each changed package to npm,
   and create a GitHub Release.
3. Requires two repo secrets the maintainer will create manually:
   `NPM_TOKEN` (npm automation token with publish rights to the
   `@notifly` scope) and the default `GITHUB_TOKEN` (provided
   automatically by Actions).

Because this is a multi-package monorepo, `semantic-release` is configured
per-package (each package versioned/released independently based on
commits scoped to its own path) rather than one version for the whole
repo.

## 10. README

A GitHub-friendly `README.md` at the repo root, including:
- Emoji section headers and a short project tagline.
- Status badges: npm version, CI build status, license, npm downloads.
- Quickstart examples for plain Node `http` and Express.
- Redis environment variable setup instructions (`REDIS_URL`).
- API reference for `@notifly/core` and `@notifly/express`.
- An architecture diagram (ASCII, matching §4).
- Contributing section pointing to conventional commit format (required
  for semantic-release to pick up changes correctly).

## 11. Error handling

- `resolveUserId` throwing or returning a nullish value rejects the WS
  upgrade (closes the socket during handshake; no connection is
  registered).
- Redis connection failures (subscriber or publisher) are surfaced via an
  `'error'` event on the `notifly` instance rather than crashing the
  host process — the app can decide how to log/handle it. Notifly does
  not retry connecting itself; it relies on `ioredis`'s built-in
  reconnection behavior.
- `send()` on a `userId` with zero subscribers anywhere is a no-op
  (matches the fire-and-forget non-goal in §3) — it does not throw.
- `notifly.close()` unsubscribes all channels, closes the WS server, and
  closes both Redis connections cleanly, for graceful shutdown.

## 12. Open items for implementation planning

- Exact TypeScript types for `resolveUserId`'s request parameter (raw
  `http.IncomingMessage` vs. framework-specific request types per
  adapter).
- Whether `@notifly/core`'s WS server should support a configurable path
  (e.g. `/notifly`) or always take over the entire `http.Server`'s
  upgrade event — needed if an app already uses WebSockets for something
  else on the same server.
- Minimum supported Node.js version (affects CI matrix and `engines`
  field).
