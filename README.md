<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">netifly</h1>

<p align="center"><strong>Real-time user notifications for Node, secure by default. Send to a user, not a channel.</strong></p>

Framework-agnostic, real-time per-user notifications for Node.js servers — WebSockets in, Redis pub/sub for horizontal scaling.

[![npm version](https://img.shields.io/npm/v/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/core.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)

## Contents

- [Why Netifly](#why-netifly)
- [Packages](#packages)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Documentation](#documentation)
- [Architecture](#architecture)
- [Testing & development](#testing--development)
- [Contributing](#contributing)
- [License](#license)

## Why Netifly

- 🔌 **Framework-agnostic core** — attaches to any Node `http.Server`, so it works under Express, Fastify, Koa, NestJS, or raw `http`.
- 🔁 **Horizontally scalable** — any number of server instances stay in sync through Redis pub/sub, no sticky sessions required.
- 🔐 **Auth-agnostic** — you supply a `resolveUserId` function; Netifly doesn't care how you authenticate.
- 🧩 **Typed events & opinionated notifications** — type-checked `send()`, plus a validated `notify()` for user-facing (and actionable) notifications.
- 💓 **Dead-connection reaping** — a ping/pong heartbeat terminates clients that silently disappeared.
- 🛡️ **Secure by default** — origin-checked WebSocket upgrades (CSWSH protection) and built-in abuse-vector limits, out of the box.

### vs. Socket.IO / Pusher

| | **Netifly** | Socket.IO | Pusher |
| --- | --- | --- | --- |
| Routing model | Per-user — `send(userId, payload)` reaches every connection that user has open | Per-room/channel — you manage the user↔socket mapping yourself | Per-channel — you manage the user↔channel mapping yourself |
| Infrastructure | Self-hosted, backed by your own Redis | Self-hosted, backed by your own adapter (Redis, etc.) | Third-party hosted service |
| Pricing | Free — you only pay for your own Redis | Free — you only pay for your own infra | Per-message / per-connection billing |
| Data path | Never leaves your infrastructure | Never leaves your infrastructure | Passes through a third party |

Netifly is deliberately narrow: no rooms, no presence, no broadcast — just "deliver this payload to this user, wherever they're connected." Reach for Socket.IO if you need room-based fan-out to anonymous clients; reach for Pusher if a managed service and its recurring bill are an acceptable trade for not running your own Redis.

## Packages

| Package | Description | README |
| --- | --- | --- |
| [`@netiflyjs/core`](https://www.npmjs.com/package/@netiflyjs/core) | The framework-agnostic engine — attaches to any Node `http.Server`. | [README](packages/core/README.md) |
| [`@netiflyjs/express`](https://www.npmjs.com/package/@netiflyjs/express) | A thin Express adapter over `core`, for one-line setup. | [README](packages/express/README.md) |
| [`@netiflyjs/client`](https://www.npmjs.com/package/@netiflyjs/client) | The browser/React Native/Node client SDK — ~1.7 KB gzipped, zero dependencies. | [README](packages/client/README.md) |
| [`@netiflyjs/react`](https://www.npmjs.com/package/@netiflyjs/react) | A provider and hooks on top of `client` — StrictMode-safe, SSR-safe. | [README](packages/react/README.md) |

## Installation

```bash
npm install @netiflyjs/core
# or, for Express apps:
npm install @netiflyjs/core @netiflyjs/express
# and, in your frontend (or any WebSocket client):
npm install @netiflyjs/client
# or, in a React frontend:
npm install @netiflyjs/react @netiflyjs/client
```

## Quickstart

```ts
import http from 'node:http';
import { createNetifly } from '@netiflyjs/core';

const server = http.createServer((req, res) => res.end('ok'));

const netifly = createNetifly({
  server,
  resolveUserId: async (req) => verifyJwtFromRequest(req), // your own auth
  redisUrl: process.env.REDIS_URL,
});

server.listen(3000);

// Anywhere in your app:
netifly.send(userId, 'comment.created', { commentId: 42 });
```

That's `@netiflyjs/core` directly on plain `http`. For Express setup, the
client SDK, React hooks, typed events, `notify()`, or sending from a
worker/serverless function with no WebSocket server at all, see each
package's own README above, or the full docs below.

## Documentation

The full docs site lives in [`docs/site/`](docs/site/README.md) in this
repo (GitBook Git Sync format):

- **[Getting started](docs/site/getting-started.md)** — install, quickstart for every package, and the typed-events pattern.
- **[Security](docs/site/security.md)** — the origin allowlist, cookie vs. token auth, and the built-in abuse-vector limits.
- **[Recipes](docs/site/recipes/README.md)** — email when offline, notifying from a BullMQ worker, handling reconnects and token refresh, building a notification inbox.
- **[API reference](docs/site/reference/README.md)** — the full, per-package reference: [`core`](docs/site/reference/core.md), [`express`](docs/site/reference/express.md), [`client`](docs/site/reference/client.md), [`react`](docs/site/reference/react.md).

## Architecture

```
Client A ──WS──► Server Instance 1 ──┐
Client B ──WS──► Server Instance 2 ──┼──► Redis (pub/sub, per-user channels)
Client C ──WS──► Server Instance 3 ──┘
```

Each instance subscribes to a user's Redis channel (`netifly:user:<id>`) only while it holds a live connection for that user, and unsubscribes the moment that user disconnects locally — so `send()` traffic only reaches the instance(s) that actually need it.

## Testing & development

This is a pnpm workspace monorepo.

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
pnpm test
pnpm build
pnpm --filter @netiflyjs/client run size      # bundle-size budget (after a build)
```

`@netiflyjs/client`'s own tests spin up a real `createNetifly()` server to run against, so they need the same Redis — and **Node 22+**, since they exercise the native `WebSocket` global. On Node 18/20, run `pnpm --filter '!@netiflyjs/client' run test` instead (that's exactly what CI does on its 18 and 20 legs; the build, lint and typecheck steps are type-only and run everywhere).

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide each package's next version and changelog automatically on merge to `main`.

## License

[MIT](./LICENSE)
