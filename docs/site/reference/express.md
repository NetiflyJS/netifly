# `@netiflyjs/express` reference

A thin Express adapter over [`@netiflyjs/core`](core.md), for one-line setup
in an Express app.

## `attachNetifly(app, options)`

Same `options` as [`createNetifly`](core.md#createnetiflyeventsoptions),
minus `server` (optional — pass your own `http.Server`, or let it create
one from the Express `app` via `http.createServer(app)`). Returns
`{ server, netifly }` where `netifly` is the same `NetiflyInstance<Events>`
[`createNetifly`](core.md#createnetiflyeventsoptions) returns.

```ts
import express from 'express';
import { attachNetifly } from '@netiflyjs/express';

const app = express();

const { server, netifly } = attachNetifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

server.listen(3000);
```

### `req.netifly` middleware

`attachNetifly` also mounts a middleware that sets `req.netifly` to the
same `NetiflyInstance` on every request `app` handles, so route handlers
defined elsewhere in your app don't need the returned `netifly` value
threaded through:

```ts
app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  req.netifly.send(comment.authorId, 'comment.created', comment); // same instance, via req
  res.status(201).json(comment);
});
```

### Upgrade requests bypass Express

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware
> entirely — Express never sees them. `resolveUserId` therefore always
> receives the raw Node `IncomingMessage`, never an Express `Request`
> (no `req.params`, `req.body`, Express-specific middleware-attached
> properties, etc.). Read whatever you need for auth directly off the raw
> request — a cookie header, a query string token — the same way you would
> with plain [`@netiflyjs/core`](core.md).

## Security

The [origin allowlist and the abuse-vector limits](../security.md) apply
identically under `attachNetifly` — they're enforced by `core` before
`resolveUserId` ever runs, regardless of which adapter sits in front of it.

## Typed events, `notify`, transport, etc.

Every option and return-value method documented in the [`core` reference](core.md)
— typed `Events`, `notify`/`notifyOr`, actionable notifications, custom
`transport`, `namespace` — is available unchanged through `attachNetifly`,
since it's a pass-through to `createNetifly()` plus the `req.netifly`
middleware above.

## All exports

Every name `@netiflyjs/express` exports from its package entry point.

| Export | Description |
| --- | --- |
| `attachNetifly` | See [`attachNetifly(app, options)`](#attachnetiflyapp-options). |
| `AttachNetiflyOptions` (type) | `Omit<CreateNetiflyOptions, 'server'> & { server?: http.Server }` — the full options object `attachNetifly()` takes; every [`core` option](core.md#createnetiflyeventsoptions) applies, with `server` optional. |
| `AttachNetiflyResult` (type) | `{ server: http.Server, netifly: NetiflyInstance }` — the return type of `attachNetifly()`. |

This package also globally augments Express's `Request` type (via
`declare global { namespace Express { interface Request { netifly: NetiflyInstance } } }`)
so `req.netifly` type-checks in any file that imports
`@netiflyjs/express` — see [`req.netifly` middleware](#reqnetifly-middleware).

## See also

- [Getting started](../getting-started.md)
- [Recipe: email when offline](../recipes/email-when-offline.md)
- [`core` reference](core.md) · [`client` reference](client.md) · [`react` reference](react.md)
