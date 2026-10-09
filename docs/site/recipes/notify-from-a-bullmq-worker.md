# Recipe: notify from a BullMQ worker

**Package:** [`@netiflyjs/core`](../reference/core.md)

A BullMQ worker process doesn't hold an `http.Server`, so `createNetifly()`
doesn't fit. `createNetiflyPublisher()` does — it opens only a Redis
**publisher** connection (no subscriber, no WebSocket server) and connects
lazily on first use.

## Full example: worker + graceful shutdown

```ts
import { createNetiflyPublisher } from '@netiflyjs/core';
import { Worker, QueueEvents } from 'bullmq';

const connection = { url: process.env.REDIS_URL! };
const publisher = createNetiflyPublisher({ redisUrl: process.env.REDIS_URL });

const worker = new Worker(
  'exports',
  async (job) => {
    const url = await generateExport(job.data);
    await publisher.send(job.data.userId, 'export.ready', { url });
    return { url };
  },
  { connection },
);

const events = new QueueEvents('exports', { connection });
events.on('failed', ({ jobId, failedReason }) => {
  console.error(`export job ${jobId} failed: ${failedReason}`);
});

// Graceful shutdown — close the publisher alongside the worker, in either order.
async function shutdown() {
  await Promise.all([worker.close(), events.close(), publisher.close()]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

A publisher in one process and a `createNetifly()` server in another are
fully interchangeable — they speak the same Redis pub/sub wire protocol,
so a publisher's `send()` delivers straight to a socket the server is
holding, wherever that server happens to be running. See the
[`core` reference](../reference/core.md#createnetiflypublishereventsoptions)
for the full `NetiflyPublisher` surface (`send`, `notify`, `isOnline`,
`whoIsOnline`, `close`).

## Same pattern, serverless

In a Lambda/Vercel function, construct the publisher **once per cold
start** (module scope, outside the handler) rather than per invocation —
its Redis connection is reused across warm invocations, and `close()` is
unnecessary unless you have a specific reason to tear it down (e.g. a
function that explicitly drains connections before returning). If you do
want to close it, call `await publisher.close()` right before the handler
returns, and recreate it lazily on the next cold start.

## Without `@netiflyjs/core` at all

You don't need this package to notify a user from another language —
`PUBLISH` directly to `netifly:user:<id>` (or
`netifly:<namespace>:user:<id>`) with a JSON-encoded
[envelope](../reference/core.md#message-envelope). See
[Publishing directly, without this library](../reference/core.md#publishing-directly-without-this-library)
for Python and Go examples.
