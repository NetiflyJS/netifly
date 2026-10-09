<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">@netiflyjs/core</h1>

<p align="center"><strong>The framework-agnostic engine behind Netifly — real-time, per-user notifications for Node.js servers.</strong></p>

[![npm version](https://img.shields.io/npm/v/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/core.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/core.svg)](https://www.npmjs.com/package/@netiflyjs/core)

Attaches a WebSocket upgrade handler to any Node `http.Server` and moves
messages between connections — and across server instances, for
horizontal scaling — through Redis pub/sub (or a pluggable transport of
your own). `netifly.send(userId, type, data)` from anywhere in your
backend reaches every connection that user holds, anywhere in your
cluster. Part of the [Netifly](https://github.com/NetiflyJS/netifly)
project — see the [root README](https://github.com/NetiflyJS/netifly) for
how this fits alongside [`@netiflyjs/express`](https://www.npmjs.com/package/@netiflyjs/express),
[`@netiflyjs/client`](https://www.npmjs.com/package/@netiflyjs/client), and
[`@netiflyjs/react`](https://www.npmjs.com/package/@netiflyjs/react).

## Contents

- [Features](#features)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Typed events](#typed-events)
- [Notifications](#notifications)
- [Recipe: email when offline](#recipe-email-when-offline)
- [API reference](#api-reference)
- [Security](#security)
- [Testing & development](#testing--development)
- [Contributing](#contributing)
- [License](#license)

## Features

- 🔌 **Framework-agnostic** — attaches to any Node `http.Server`: Express, Fastify, Koa, NestJS, or raw `http`.
- 🔁 **Horizontally scalable** — any number of server instances stay in sync through Redis pub/sub, no sticky sessions required.
- 🔐 **Auth-agnostic** — you supply a `resolveUserId` function; Netifly doesn't care how you authenticate.
- 🧩 **Typed events** — an optional `Events` map type-checks `send()`/`sendOr()` against your own event names and payload shapes.
- ✉️ **Opinionated notifications** — `notify()` adds server-validated, user-facing notifications (including signed, verifiable actionable ones) on top of the same delivery path as `send()`.
- 💓 **Dead-connection reaping** — a ping/pong heartbeat terminates clients that silently disappeared.

## Installation

```bash
npm install @netiflyjs/core
```

Requires a Redis connection string (`REDIS_URL` env var, or the `redisUrl`
option) — there's no local-Redis fallback. See
[Transport](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/core.md#transport)
for running against `memoryTransport()` instead, e.g. in your own test suite.

## Getting started

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

Using Express? [`@netiflyjs/express`](https://www.npmjs.com/package/@netiflyjs/express)
wraps this in `attachNetifly(app, options)` for one-line setup, plus a
`req.netifly` middleware.

## Typed events

```ts
type Events = {
  'comment.created': { commentId: string };
  'export.ready': { url: string };
};

const netifly = createNetifly<Events>({ server, resolveUserId, redisUrl });

netifly.send(userId, 'export.ready', { url });        // ✅ type-checks
netifly.send(userId, 'export.ready', { url: 123 });   // ❌ type error
```

The same `Events` map is shared with [`@netiflyjs/client`](https://www.npmjs.com/package/@netiflyjs/client)
for type-checked handlers on the receiving end. Pass a `validate` option
for runtime enforcement (e.g. with [Zod](https://zod.dev)) — see the
[full reference](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/core.md#typed-events).

## Notifications

`notify()` is a validated, opinionated layer over `send()` for the common
case of a user-facing notification — including actionable ones with
cryptographically verified CTA buttons:

```ts
await netifly.notify(userId, {
  kind: 'info',
  title: 'Export ready',
  body: 'Your March report has finished generating.',
  link: { href: '/reports/123', label: 'Open' },
});
```

See the full reference for [actionable notifications](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/core.md#actionable-notifications)
and the `actionSecret` option they require.

## Recipe: email when offline

`send()`/`notify()` report `delivered` at publish time, so you can fall
back to another channel without polling:

```ts
await netifly.sendOr(userId, 'invoice.ready', data, {
  offline: () => sendEmail(userId, 'Your invoice is ready', data),
});
```

Full worked example (Express route + Resend), plus the idempotency
caveat: [Recipe: email when offline](https://github.com/NetiflyJS/netifly/blob/main/docs/site/recipes/email-when-offline.md).
Sending from a process with no WebSocket server at all (a worker, cron
job, serverless function)? See
[Recipe: notify from a BullMQ worker](https://github.com/NetiflyJS/netifly/blob/main/docs/site/recipes/notify-from-a-bullmq-worker.md).

## API reference

`createNetifly<Events>(options)` returns a `NetiflyInstance<Events>`:
`send`, `sendOr`, `notify`, `notifyOr`, `disconnect`, `on(...)`, `close`,
`isOnline`, `whoIsOnline`, `isConnectedHere`. `createNetiflyPublisher<Events>(options)`
is the send-only counterpart for workers/serverless (no `server`, no
subscriber connection).

This README covers the quickstart; every option, event payload, and the
wire-level [message envelope](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/core.md#message-envelope)
are documented in full in the
**[`core` API reference](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/core.md)**.

## Security

Netifly checks the `Origin` header before `resolveUserId` ever runs
(same-host only, by default) to prevent cross-site WebSocket hijacking,
and ships built-in limits for inbound frame size, outbound buffer growth,
and connections per user. See
[Security](https://github.com/NetiflyJS/netifly/blob/main/docs/site/security.md)
for the full allowlist syntax and limit defaults.

## Testing & development

This package lives in the Netifly pnpm workspace monorepo.

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
pnpm --filter @netiflyjs/core test
pnpm --filter @netiflyjs/core build
```

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide
this package's next version and changelog automatically on merge to `main`.
See the [root README](https://github.com/NetiflyJS/netifly) for the full
contributor workflow.

## License

[MIT](./LICENSE)
