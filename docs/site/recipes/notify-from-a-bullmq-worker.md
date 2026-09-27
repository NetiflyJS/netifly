# Recipe: notify from a BullMQ worker

> **Status:** stub — outline below, full runnable example to follow.

A BullMQ worker process doesn't hold an `http.Server`, so `createNetifly()`
doesn't fit. `createNetiflyPublisher()` does — it opens only a Redis
**publisher** connection (no subscriber, no WebSocket server) and connects
lazily on first use:

```ts
import { createNetiflyPublisher } from '@netiflyjs/core';
import { Worker } from 'bullmq';

const publisher = createNetiflyPublisher({ redisUrl: process.env.REDIS_URL });

const worker = new Worker('exports', async (job) => {
  const url = await generateExport(job.data);
  await publisher.send(job.data.userId, 'export.ready', { url });
});

// On worker shutdown:
await publisher.close();
```

A publisher in one process and a `createNetifly()` server in another are
fully interchangeable — they speak the same Redis pub/sub wire protocol, so
a publisher's `send()` delivers straight to a socket the server is holding,
wherever that server happens to be running. See the
[`core` reference](../reference/core.md) for the full `NetiflyPublisher`
surface (`send`, `isOnline`, `whoIsOnline`, `close`).

## To expand

- A complete BullMQ `Worker`/`QueueEvents` example, including graceful
  shutdown ordering (`publisher.close()` alongside `worker.close()`).
- Same pattern for a Lambda/Vercel function or cron job — construct once
  per invocation or reuse across invocations, whichever fits your runtime's
  connection-reuse model.
- Publishing without `@netiflyjs/core` at all, from another language —
  channel naming (`netifly:user:<id>`) and envelope shape are documented in
  the [`core` reference](../reference/core.md).
