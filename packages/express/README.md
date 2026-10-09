<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/NetiflyJS/netifly/main/assets/brand/netifly-mark.svg" alt="Netifly" width="96">
  </picture>
</p>

<h1 align="center">@netiflyjs/express</h1>

<p align="center"><strong>One-line Express setup for Netifly — real-time, per-user WebSocket notifications.</strong></p>

[![npm version](https://img.shields.io/npm/v/@netiflyjs/express.svg)](https://www.npmjs.com/package/@netiflyjs/express)
[![CI](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/NetiflyJS/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netiflyjs/express.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netiflyjs/express.svg)](https://www.npmjs.com/package/@netiflyjs/express)

A thin adapter over [`@netiflyjs/core`](https://www.npmjs.com/package/@netiflyjs/core)
for Express apps: one function call attaches the WebSocket upgrade handler
to your app's server and exposes the same `NetiflyInstance` as
`req.netifly` on every request. Part of the
[Netifly](https://github.com/NetiflyJS/netifly) project.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Recipe: notify from a route handler](#recipe-notify-from-a-route-handler)
- [API reference](#api-reference)
- [Security](#security)
- [Testing & development](#testing--development)
- [Contributing](#contributing)
- [License](#license)

## Features

- ⚡ **One-line setup** — `attachNetifly(app, options)` returns `{ server, netifly }`; no separate `createNetifly()` call needed.
- 🧵 **`req.netifly` middleware** — every route handler gets the same `NetiflyInstance` via `req.netifly`, no threading a module-level variable through your router.
- 🪪 **Every `@netiflyjs/core` option and event, unchanged** — typed events, `notify()`, actionable notifications, custom transports — this package is a pass-through plus the middleware above.

## Installation

```bash
npm install @netiflyjs/core @netiflyjs/express
```

## Getting started

```ts
import express from 'express';
import { attachNetifly } from '@netiflyjs/express';

const app = express();

const { server, netifly } = attachNetifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
  redisUrl: process.env.REDIS_URL,
});

app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  req.netifly.send(comment.authorId, 'comment.created', comment); // via req.netifly
  res.status(201).json(comment);
});

server.listen(3000);
```

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware
> entirely, so `resolveUserId` always receives the raw Node
> `IncomingMessage`, never an Express `Request`.

## Recipe: notify from a route handler

Combine `req.netifly` with `sendOr()` to fall back to email when the user
isn't connected, right inside a normal Express handler — full worked
example: [Recipe: email when offline](https://github.com/NetiflyJS/netifly/blob/main/docs/site/recipes/email-when-offline.md).

## API reference

`attachNetifly(app, options)` takes the exact same `options` as
`createNetifly` from `@netiflyjs/core` (minus `server`, which it can build
for you from `app`). Full option table, every event, and the `req.netifly`
middleware's exact semantics are documented in the
**[`express` API reference](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/express.md)**
— which also links to the [`core` reference](https://github.com/NetiflyJS/netifly/blob/main/docs/site/reference/core.md)
for everything this package passes through unchanged (typed events,
`notify`, transport, etc.).

## Security

The origin allowlist and abuse-vector limits documented in
[Security](https://github.com/NetiflyJS/netifly/blob/main/docs/site/security.md)
apply identically here — they're enforced by `@netiflyjs/core` before
`resolveUserId` ever runs, regardless of which adapter sits in front of it.

## Testing & development

This package lives in the Netifly pnpm workspace monorepo.

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
pnpm --filter @netiflyjs/express test
pnpm --filter @netiflyjs/express build
```

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide
this package's next version and changelog automatically on merge to `main`.
See the [root README](https://github.com/NetiflyJS/netifly) for the full
contributor workflow.

## License

[MIT](./LICENSE)
