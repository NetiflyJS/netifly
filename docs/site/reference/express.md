# `@netiflyjs/express` reference

> **Status:** stub — full prose to follow. See the
> [root README's API Reference](https://github.com/NetiflyJS/netifly#-api-reference)
> for complete detail in the meantime.

## `attachNetifly(app, options)`

Same `options` as [`createNetifly`](core.md), minus `server` (optional —
pass your own, or let it create one from the Express `app`). Returns
`{ server, netifly }`.

Also mounts a middleware that sets `req.netifly: NetiflyInstance` on every
request `app` handles, so route handlers can call `req.netifly.send(...)`
directly instead of importing/threading the returned `netifly` value.

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware
> entirely, so `resolveUserId` always receives the raw Node
> `IncomingMessage`, never an Express `Request` — see
> [Getting started](../getting-started.md).

## To expand

- A worked example beyond the [getting-started](../getting-started.md)
  quickstart (e.g. multiple routers, error middleware interaction).
