# Transport Abstraction + In-Memory Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put `createNetifly()`'s message-routing layer behind a `NetiflyTransport` interface, and ship two implementations — `redisTransport()` (today's Redis behavior, extracted) and `memoryTransport()` (new, dependency-free, single-process) — so Postgres/Redis-Cluster/in-memory-testing transports (NOT-26, NOT-32, NOT-23) can be added later without further changes to `createNetifly()` itself.

**Architecture:** `RedisRouter` is renamed/restructured into `redisTransport()`, a factory returning a plain `NetiflyTransport` object; its ref-counting logic is lifted out into a separate `RefCountedTransport` decorator that `createNetifly()` always wraps around whichever raw transport it ends up with (built internally from `redisUrl`, or supplied via the new `transport` option). Every transport moves pre-serialized JSON strings only — `netiflyServer` serializes once, centrally, before calling `transport.publish()`.

**Tech Stack:** TypeScript, `ws` (WebSocketServer), `ioredis`, Jest + `ts-jest`, real (non-mocked) Redis + WebSocket connections in tests — this repo's existing convention (see `packages/core/src/netiflyServer.test.ts`).

**Spec:** [docs/superpowers/specs/2026-09-29-transport-abstraction-design.md](../specs/2026-09-29-transport-abstraction-design.md)

## Global Constraints

- `message` passed to `NetiflyTransport.publish()`/received via `onMessage()` is always a pre-serialized JSON string — no transport parses or serializes application data (spec §6).
- `RefCountedTransport` is never exported from `index.ts` — it is `createNetifly()`'s own internal wiring, not part of the public transport contract (spec §3, §5).
- Passing both `transport` and `namespace` to `createNetifly()` throws synchronously at construction (spec §7).
- `redisUrl`/`REDIS_URL`/`namespace` keep working exactly as today when `transport` is not passed — this is purely additive (spec §7, §11).
- `memoryTransport()` takes no arguments and models exactly one process — no multi-instance bus in this ticket (spec §3, §8).
- `NetiflyPublisher` is not touched in this ticket — it keeps its current, direct-Redis implementation (spec §3).
- `@netiflyjs/client` and `@netiflyjs/express` need no code changes — only `@netiflyjs/core` changes (spec §11).

## Review Focus

- Passing both `transport` and `namespace` to `createNetifly()` must throw synchronously at construction — not silently prefer one or ignore the other. Covered in Task 4.
- A non-JSON-serializable `send()` payload must still be rejected with the exact same `"Netifly: payload for user ... is not JSON-serializable"` error, now thrown from `netiflyServer` instead of the transport — not silently swallowed or reshaped. Covered in Task 4.
- Two overlapping local connections for the same user (multi-tab) must not let one connection's unsubscribe tear down the other's subscription, now that ref-counting has moved out of the raw transport and into `RefCountedTransport` — this is a real regression risk for the NOT-5 fix during this move. Covered in Task 2 and Task 4.
- `receivers([])` (both `memoryTransport()` and `redisTransport()`) must resolve to `{}` without erroring — an app checking presence for a dynamic, sometimes-empty list of watched users hits this for real, not just as an edge case to skip. Covered in Task 1 and Task 4.
- `close()` on a transport that was constructed but never subscribed to anything (e.g. an app closing a `memoryTransport()`/`redisTransport()` it built for its own tests without ever connecting a client) must not throw. Covered in Task 1 and Task 3.

---

## File Structure

- `packages/core/src/types.ts` (modify) — new `NetiflyTransport` interface; new `CreateNetiflyOptions.transport` option.
- `packages/core/src/transports/transport.contract.ts` (new) — `runTransportContractTests(name, makeTransport)`, the shared behavioral suite every transport runs against. Not a `.test.ts` file itself (it has no tests of its own to run standalone) — it's imported by the test files below.
- `packages/core/src/transports/memoryTransport.ts` (new) — `memoryTransport()`.
- `packages/core/src/transports/memoryTransport.test.ts` (new) — runs the contract suite + memory-specific tests.
- `packages/core/src/transports/refCountedTransport.ts` (new) — `RefCountedTransport` class.
- `packages/core/src/transports/refCountedTransport.test.ts` (new) — ref-count overlap tests against a fake raw transport.
- `packages/core/src/transports/redisTransport.ts` (new, replaces `packages/core/src/redisRouter.ts`) — `redisTransport()` factory + `RedisTransportImpl` class + `channelName()`.
- `packages/core/src/transports/redisTransport.test.ts` (new, replaces `packages/core/src/redisRouter.test.ts`) — runs the contract suite + Redis-specific tests (namespace isolation, `onError`, `close()` semantics).
- `packages/core/src/redisRouter.ts` (delete) — superseded by `transports/redisTransport.ts`.
- `packages/core/src/redisRouter.test.ts` (delete) — superseded by `transports/redisTransport.test.ts` + the contract suite + `refCountedTransport.test.ts`.
- `packages/core/src/netiflyServer.ts` (modify) — constructs/wraps the transport, routes all message/presence/lifecycle calls through it, centralizes envelope serialization.
- `packages/core/src/netiflyServer.test.ts` (modify) — retargets the NOT-5 race-condition spy at `RefCountedTransport`, updates the `RedisRouter` import, adds `transport`/`namespace` mutual-exclusion and `memoryTransport()` round-trip tests.
- `packages/core/src/netiflyPublisher.ts` (modify) — one-line import path fix (`channelName` now lives in `transports/redisTransport.ts`); no behavioral change.
- `packages/core/src/redisDisconnect.ts` (modify) — one doc-comment path fix.
- `packages/core/src/index.ts` (modify) — exports `NetiflyTransport`, `RedisTransportOptions`, `redisTransport`, `memoryTransport`.
- `README.md` (modify) — new `transport` option row, new "Transport" section, `memoryTransport()` dev/test note.
- `docs/site/reference/core.md` (modify) — same coverage, GitBook-site copy.

---

### Task 1: `NetiflyTransport` interface, shared contract suite, `memoryTransport()`

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `packages/core/src/transports/transport.contract.ts`
- Create: `packages/core/src/transports/memoryTransport.ts`
- Test: `packages/core/src/transports/memoryTransport.test.ts`

**Interfaces:**
- Produces: `NetiflyTransport` (in `types.ts`) — `{ subscribe(userId): Promise<void>; unsubscribe(userId): Promise<void>; publish(userId, message: string): Promise<{ receivers: number }>; receivers(userIds: UserId[]): Promise<Record<UserId, number>>; onMessage(cb): void; onError(cb): void; close(): Promise<void> }`. `runTransportContractTests(name: string, makeTransport: () => NetiflyTransport): void`. `memoryTransport(): NetiflyTransport`. Tasks 2, 3, 4 all import `NetiflyTransport`; Tasks 2 and 3 import `runTransportContractTests`.

- [ ] **Step 1: Add the `NetiflyTransport` interface to `types.ts`**

In `packages/core/src/types.ts`, add this interface right after the `AllowedOrigins` type and before `CreateNetiflyOptions` (i.e. right after the block ending `| '*';` that closes `AllowedOrigins`):

```typescript
/**
 * The contract `createNetifly()` depends on for moving messages between
 * connections and across server instances. `redisTransport()` and
 * `memoryTransport()` are the two built-in implementations (see the NOT-20
 * design spec). `createNetifly()` wraps whichever transport it is given in
 * an internal ref-counting decorator, so an implementation of this
 * interface never needs to handle overlapping subscribe()/unsubscribe()
 * calls for the same userId itself.
 */
export interface NetiflyTransport {
  subscribe(userId: UserId): Promise<void>;
  unsubscribe(userId: UserId): Promise<void>;
  /** `message` is always a pre-serialized JSON string — see the NOT-20 design spec §6. */
  publish(userId: UserId, message: string): Promise<{ receivers: number }>;
  /** Batched presence check — `isOnline`/`whoIsOnline` both route through this. Resolves `{}` for an empty array. */
  receivers(userIds: UserId[]): Promise<Record<UserId, number>>;
  /** Registers the single callback invoked for every message this transport receives. */
  onMessage(cb: (userId: UserId, message: string) => void): void;
  /** Registers the single callback invoked for background/connection errors. */
  onError(cb: (error: Error) => void): void;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (nothing references `NetiflyTransport` yet, so this just checks the interface itself is well-formed).

- [ ] **Step 3: Write the shared transport contract suite**

Create `packages/core/src/transports/transport.contract.ts`:

```typescript
import type { NetiflyTransport, UserId } from '../types';

/**
 * The behavioral contract every `NetiflyTransport` implementation must
 * satisfy (NOT-20 design spec §10), run against both `redisTransport` and
 * `memoryTransport` from their own test files. Ref-counted overlapping
 * subscribe()/unsubscribe() is deliberately NOT part of this contract —
 * that's `RefCountedTransport`'s job (see `refCountedTransport.test.ts`),
 * not a raw transport's, since `createNetifly()` always wraps a raw
 * transport in it before overlap can occur.
 */
export function runTransportContractTests(
  name: string,
  makeTransport: () => NetiflyTransport
): void {
  describe(`${name} transport contract`, () => {
    let transports: NetiflyTransport[];

    beforeEach(() => {
      transports = [];
    });

    afterEach(async () => {
      await Promise.all(transports.map((transport) => transport.close()));
    });

    function create(): NetiflyTransport {
      const transport = makeTransport();
      transports.push(transport);
      return transport;
    }

    it('delivers a published message to a subscribed transport', async () => {
      const subscriber = create();
      const publisher = create();
      const received: Array<{ userId: UserId; message: string }> = [];
      let resolveReceived: () => void;
      const receivedPromise = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      subscriber.onMessage((userId, message) => {
        received.push({ userId, message });
        resolveReceived();
      });

      await subscriber.subscribe('contract-alice');
      await publisher.publish('contract-alice', JSON.stringify({ hello: 'world' }));
      await receivedPromise;

      expect(received).toEqual([
        { userId: 'contract-alice', message: JSON.stringify({ hello: 'world' }) },
      ]);
    });

    it('does not deliver to a userId nobody has subscribed to', async () => {
      const publisher = create();
      const other = create();
      const onMessage = jest.fn();
      other.onMessage(onMessage);

      await publisher.publish('contract-nobody-home', JSON.stringify({ hello: 'world' }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', async () => {
      const subscriber = create();
      const publisher = create();
      const onMessage = jest.fn();
      subscriber.onMessage(onMessage);

      await subscriber.subscribe('contract-bob');
      await subscriber.unsubscribe('contract-bob');
      await publisher.publish('contract-bob', JSON.stringify({ hello: 'world' }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('publish() resolves with the current receiver count', async () => {
      const subscriber = create();
      const publisher = create();
      subscriber.onMessage(() => {});

      await expect(
        publisher.publish('contract-receivers', JSON.stringify({ a: 1 }))
      ).resolves.toEqual({ receivers: 0 });

      await subscriber.subscribe('contract-receivers');
      await expect(
        publisher.publish('contract-receivers', JSON.stringify({ a: 1 }))
      ).resolves.toEqual({ receivers: 1 });
    });

    it('receivers() reflects subscription state for every requested userId', async () => {
      const subscriber = create();
      const other = create();
      subscriber.onMessage(() => {});

      await subscriber.subscribe('contract-presence-a');
      await expect(
        other.receivers(['contract-presence-a', 'contract-presence-b'])
      ).resolves.toEqual({ 'contract-presence-a': 1, 'contract-presence-b': 0 });
    });

    it('receivers([]) resolves {} without erroring', async () => {
      const other = create();
      await expect(other.receivers([])).resolves.toEqual({});
    });

    it('close() on a transport that was never subscribed to anything does not throw', async () => {
      const transport = makeTransport(); // not pushed to `transports` — closed here directly
      await expect(transport.close()).resolves.toBeUndefined();
    });

    it('close() stops delivering to a previously subscribed transport', async () => {
      const subscriber = makeTransport(); // not pushed — closed explicitly below
      const publisher = create();
      const onMessage = jest.fn();
      subscriber.onMessage(onMessage);
      await subscriber.subscribe('contract-close');

      await subscriber.close();

      await publisher.publish('contract-close', JSON.stringify({ a: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });
  });
}
```

- [ ] **Step 4: Write `memoryTransport()` and its failing tests**

Create `packages/core/src/transports/memoryTransport.ts`:

```typescript
import type { NetiflyTransport, UserId } from '../types';

/**
 * A single-process, dependency-free NetiflyTransport for local development
 * and tests — no Redis required (NOT-20 design spec §8). Models exactly one
 * process: `receivers()` here means "subscribed on this process," not
 * cluster-wide presence.
 */
export function memoryTransport(): NetiflyTransport {
  const subscribers = new Set<UserId>();
  let onMessageCb: ((userId: UserId, message: string) => void) | undefined;
  let onErrorCb: ((error: Error) => void) | undefined;

  return {
    async subscribe(userId) {
      subscribers.add(userId);
    },

    async unsubscribe(userId) {
      subscribers.delete(userId);
    },

    async publish(userId, message) {
      const receivers = subscribers.has(userId) ? 1 : 0;
      if (receivers > 0) {
        // Delivered asynchronously, not in the same tick as publish() —
        // code/tests written against one transport must not accidentally
        // depend on timing behavior that only this transport happens to
        // provide (NOT-20 design spec §8).
        queueMicrotask(() => onMessageCb?.(userId, message));
      }
      return { receivers };
    },

    async receivers(userIds) {
      const counts: Record<UserId, number> = {};
      for (const userId of userIds) {
        counts[userId] = subscribers.has(userId) ? 1 : 0;
      }
      return counts;
    },

    onMessage(cb) {
      onMessageCb = cb;
    },

    // Realistically never invoked — there is no background connection that
    // can fail for an in-memory transport. Exists to satisfy the interface.
    onError(cb) {
      onErrorCb = cb;
    },

    async close() {
      subscribers.clear();
      onMessageCb = undefined;
      onErrorCb = undefined;
    },
  };
}
```

Create `packages/core/src/transports/memoryTransport.test.ts`:

```typescript
import { memoryTransport } from './memoryTransport';
import { runTransportContractTests } from './transport.contract';

runTransportContractTests('memoryTransport', () => memoryTransport());

describe('memoryTransport', () => {
  it('delivers asynchronously, not synchronously within publish()', async () => {
    const transport = memoryTransport();
    const onMessage = jest.fn();
    transport.onMessage(onMessage);
    await transport.subscribe('memory-async');

    void transport.publish('memory-async', JSON.stringify({ a: 1 }));
    expect(onMessage).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).toHaveBeenCalledWith('memory-async', JSON.stringify({ a: 1 }));

    await transport.close();
  });

  it('receivers() only ever reports 0 or 1 — this transport models exactly one process', async () => {
    const transport = memoryTransport();
    await transport.subscribe('memory-solo');
    await transport.subscribe('memory-solo'); // subscribing twice is not this transport's concern (ref-counting lives above it)

    await expect(transport.receivers(['memory-solo'])).resolves.toEqual({ 'memory-solo': 1 });

    await transport.close();
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd packages/core && npx jest transports/memoryTransport.test.ts`
Expected: FAIL — `Cannot find module './memoryTransport'` / `'./transport.contract'` (files exist per Step 3-4 above, so if you've followed the steps in order this should already PASS — if you're verifying TDD-style before writing the implementation, temporarily comment out the body of `memoryTransport.ts`'s returned object methods to confirm the tests actually exercise real behavior, then restore it).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/core && npx jest transports/memoryTransport.test.ts`
Expected: PASS (all cases, including the 8 contract-suite cases run under the `memoryTransport transport contract` describe block)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/transports/transport.contract.ts packages/core/src/transports/memoryTransport.ts packages/core/src/transports/memoryTransport.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add NetiflyTransport interface, contract suite, and memoryTransport() (NOT-20)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `RefCountedTransport` — shared ref-counting wrapper

**Files:**
- Create: `packages/core/src/transports/refCountedTransport.ts`
- Test: `packages/core/src/transports/refCountedTransport.test.ts`

**Interfaces:**
- Consumes: `NetiflyTransport` from Task 1 (`../types`).
- Produces: `class RefCountedTransport implements NetiflyTransport { constructor(raw: NetiflyTransport) }`. Task 4 imports and constructs this around whichever raw transport `createNetifly()` ends up with.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/transports/refCountedTransport.test.ts`:

```typescript
import { RefCountedTransport } from './refCountedTransport';
import type { NetiflyTransport, UserId } from '../types';

function createFakeTransport(): NetiflyTransport & {
  subscribeCalls: UserId[];
  unsubscribeCalls: UserId[];
} {
  const subscribeCalls: UserId[] = [];
  const unsubscribeCalls: UserId[] = [];
  return {
    subscribeCalls,
    unsubscribeCalls,
    async subscribe(userId) {
      subscribeCalls.push(userId);
    },
    async unsubscribe(userId) {
      unsubscribeCalls.push(userId);
    },
    async publish() {
      return { receivers: 0 };
    },
    async receivers() {
      return {};
    },
    onMessage() {},
    onError() {},
    async close() {},
  };
}

describe('RefCountedTransport', () => {
  it('subscribes the raw transport only once for two calls on behalf of the same userId', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-a');
    await wrapped.subscribe('user-a');

    expect(fake.subscribeCalls).toEqual(['user-a']);
  });

  // NOT-5: two callers subscribing on behalf of the same userId (e.g. two
  // WebSocket connections for the same user) must not be able to tear down
  // each other's subscription.
  it('keeps the raw transport subscribed for a second caller after the first of two overlapping subscribers unsubscribes', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-overlap');
    await wrapped.subscribe('user-overlap'); // second overlapping subscriber
    await wrapped.unsubscribe('user-overlap'); // first subscriber's cleanup

    expect(fake.unsubscribeCalls).toEqual([]);
  });

  it('only unsubscribes the raw transport once every overlapping subscriber has unsubscribed', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-overlap-close');
    await wrapped.subscribe('user-overlap-close');
    await wrapped.unsubscribe('user-overlap-close');
    await wrapped.unsubscribe('user-overlap-close');

    expect(fake.unsubscribeCalls).toEqual(['user-overlap-close']);
  });

  it('re-subscribes the raw transport after a full unsubscribe/subscribe cycle', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-cycle');
    await wrapped.unsubscribe('user-cycle');
    await wrapped.subscribe('user-cycle');

    expect(fake.subscribeCalls).toEqual(['user-cycle', 'user-cycle']);
  });

  it('rolls back the ref count if the raw transport rejects subscribe(), so the next call retries it', async () => {
    const fake = createFakeTransport();
    fake.subscribe = jest.fn().mockRejectedValueOnce(new Error('boom'));
    const wrapped = new RefCountedTransport(fake);

    await expect(wrapped.subscribe('user-fail')).rejects.toThrow('boom');

    fake.subscribe = jest.fn().mockResolvedValue(undefined);
    await wrapped.subscribe('user-fail');
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
  });

  it('passes publish/receivers/onMessage/onError/close straight through to the raw transport', async () => {
    const fake = createFakeTransport();
    fake.publish = jest.fn().mockResolvedValue({ receivers: 2 });
    fake.receivers = jest.fn().mockResolvedValue({ a: 1 });
    fake.onMessage = jest.fn();
    fake.onError = jest.fn();
    fake.close = jest.fn().mockResolvedValue(undefined);
    const wrapped = new RefCountedTransport(fake);
    const onMessageCb = () => {};
    const onErrorCb = () => {};

    await expect(wrapped.publish('a', 'msg')).resolves.toEqual({ receivers: 2 });
    await expect(wrapped.receivers(['a'])).resolves.toEqual({ a: 1 });
    wrapped.onMessage(onMessageCb);
    wrapped.onError(onErrorCb);
    await wrapped.close();

    expect(fake.publish).toHaveBeenCalledWith('a', 'msg');
    expect(fake.receivers).toHaveBeenCalledWith(['a']);
    expect(fake.onMessage).toHaveBeenCalledWith(onMessageCb);
    expect(fake.onError).toHaveBeenCalledWith(onErrorCb);
    expect(fake.close).toHaveBeenCalled();
  });

  it('close() clears its ref-count map — a subsequent subscribe() after close() subscribes the raw transport again', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-after-close');
    await wrapped.subscribe('user-after-close');
    await wrapped.close();

    await wrapped.subscribe('user-after-close');
    expect(fake.subscribeCalls).toEqual(['user-after-close', 'user-after-close']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest transports/refCountedTransport.test.ts`
Expected: FAIL — `Cannot find module './refCountedTransport'`

- [ ] **Step 3: Implement**

Create `packages/core/src/transports/refCountedTransport.ts`:

```typescript
import type { NetiflyTransport, UserId } from '../types';

/**
 * Ref-counts subscribe()/unsubscribe() per userId on top of any raw
 * NetiflyTransport, so overlapping callers (e.g. two WebSocket connections
 * for the same user) can never tear down each other's subscription (NOT-5).
 * The wrapped transport's own subscribe()/unsubscribe() are called only on
 * the first-in/last-out transition — every other method passes straight
 * through unchanged. `createNetifly()` always wraps whichever raw transport
 * it ends up with in this class; it is not exported from `index.ts` — it's
 * internal wiring, not part of the public transport contract (NOT-20 design
 * spec §5).
 */
export class RefCountedTransport implements NetiflyTransport {
  private readonly refCounts = new Map<UserId, number>();

  constructor(private readonly raw: NetiflyTransport) {}

  async subscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    this.refCounts.set(userId, count + 1);
    if (count > 0) return; // someone else already holds this open

    try {
      await this.raw.subscribe(userId);
    } catch (error) {
      const current = this.refCounts.get(userId) ?? 1;
      if (current <= 1) this.refCounts.delete(userId);
      else this.refCounts.set(userId, current - 1);
      throw error;
    }
  }

  async unsubscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    if (count <= 1) {
      this.refCounts.delete(userId);
      if (count === 1) {
        await this.raw.unsubscribe(userId);
      }
      return;
    }
    this.refCounts.set(userId, count - 1);
  }

  publish(userId: UserId, message: string): Promise<{ receivers: number }> {
    return this.raw.publish(userId, message);
  }

  receivers(userIds: UserId[]): Promise<Record<UserId, number>> {
    return this.raw.receivers(userIds);
  }

  onMessage(cb: (userId: UserId, message: string) => void): void {
    this.raw.onMessage(cb);
  }

  onError(cb: (error: Error) => void): void {
    this.raw.onError(cb);
  }

  async close(): Promise<void> {
    this.refCounts.clear();
    await this.raw.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest transports/refCountedTransport.test.ts`
Expected: PASS (all 7 cases)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transports/refCountedTransport.ts packages/core/src/transports/refCountedTransport.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add RefCountedTransport, lifting subscribe overlap out of the raw transport (NOT-20)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `redisTransport()` — extract and restructure from `RedisRouter`

**Files:**
- Create: `packages/core/src/transports/redisTransport.ts` (replaces `packages/core/src/redisRouter.ts`)
- Test: `packages/core/src/transports/redisTransport.test.ts` (replaces `packages/core/src/redisRouter.test.ts`)
- Delete: `packages/core/src/redisRouter.ts`, `packages/core/src/redisRouter.test.ts`
- Modify: `packages/core/src/netiflyPublisher.ts` (import path only)
- Modify: `packages/core/src/redisDisconnect.ts` (doc comment only)

**Interfaces:**
- Consumes: `NetiflyTransport` (Task 1), `runTransportContractTests` (Task 1), `disconnectRedis` (existing `../redisDisconnect`).
- Produces: `redisTransport(url: string, options?: RedisTransportOptions): NetiflyTransport`, `RedisTransportOptions { namespace?: string }`, `channelName(userId, namespace?): string`. Also exports `RedisTransportImpl` (the concrete class) purely so its own test file can assert on internal connection state via bracket-notation access — not meant for use outside this module. Task 4 imports `redisTransport`; Task 5 exports `redisTransport`, `RedisTransportOptions`, and `NetiflyTransport` from `index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/transports/redisTransport.test.ts`:

```typescript
import { redisTransport, RedisTransportImpl, RedisTransportOptions, channelName } from './redisTransport';
import { runTransportContractTests } from './transport.contract';
import type { NetiflyTransport } from '../types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

describe('channelName', () => {
  it('formats the per-user channel name', () => {
    expect(channelName('alice')).toBe('netifly:user:alice');
  });

  it('formats a namespaced per-user channel name (NOT-18)', () => {
    expect(channelName('alice', 'tenant-a')).toBe('netifly:tenant-a:user:alice');
  });

  it('throws for an empty userId (NOT-18)', () => {
    expect(() => channelName('')).toThrow(
      'Netifly: userId must be a non-empty string of at most 256 characters'
    );
  });

  it('throws for a userId over the max length (NOT-18)', () => {
    expect(() => channelName('a'.repeat(257))).toThrow(
      'Netifly: userId must be a non-empty string of at most 256 characters'
    );
  });
});

runTransportContractTests('redisTransport', () => redisTransport(REDIS_URL));

describe('redisTransport', () => {
  let transports: NetiflyTransport[];

  beforeEach(() => {
    transports = [];
  });

  afterEach(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
  });

  function create(options?: RedisTransportOptions): NetiflyTransport {
    const transport = redisTransport(REDIS_URL, options);
    transports.push(transport);
    return transport;
  }

  // NOT-18: two apps (or staging/prod) sharing one Redis instance must not
  // receive each other's notifications just because they happen to pick the
  // same userId. namespace scopes the channel name per-tenant.
  it('isolates two namespaces sharing the same Redis and userId (NOT-18)', async () => {
    const subscriberA = create({ namespace: 'tenant-a' });
    const subscriberB = create({ namespace: 'tenant-b' });
    const publisherA = create({ namespace: 'tenant-a' });
    const onMessageA = jest.fn();
    const onMessageB = jest.fn();
    subscriberA.onMessage(onMessageA);
    subscriberB.onMessage(onMessageB);

    await subscriberA.subscribe('redisTransport-shared-tenant');
    await subscriberB.subscribe('redisTransport-shared-tenant');
    await publisherA.publish(
      'redisTransport-shared-tenant',
      JSON.stringify({ hello: 'tenant-a only' })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessageA).toHaveBeenCalledWith(
      'redisTransport-shared-tenant',
      JSON.stringify({ hello: 'tenant-a only' })
    );
    expect(onMessageB).not.toHaveBeenCalled();
  });

  it('isolates a namespaced transport from a default (no-namespace) transport for the same userId (NOT-18)', async () => {
    const defaultSubscriber = create();
    const namespacedSubscriber = create({ namespace: 'tenant-a' });
    const defaultPublisher = create();
    const onMessageDefault = jest.fn();
    const onMessageNamespaced = jest.fn();
    defaultSubscriber.onMessage(onMessageDefault);
    namespacedSubscriber.onMessage(onMessageNamespaced);

    await defaultSubscriber.subscribe('redisTransport-shared-default');
    await namespacedSubscriber.subscribe('redisTransport-shared-default');
    await defaultPublisher.publish(
      'redisTransport-shared-default',
      JSON.stringify({ hello: 'default only' })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessageDefault).toHaveBeenCalledWith(
      'redisTransport-shared-default',
      JSON.stringify({ hello: 'default only' })
    );
    expect(onMessageNamespaced).not.toHaveBeenCalled();
  });

  // Presence must respect namespace the same way subscribe/publish do —
  // otherwise a namespaced deployment's isOnline()/whoIsOnline() would
  // silently check the wrong (unnamespaced) channel.
  it('receivers() is namespace-aware, matching subscribe/unsubscribe/publish (NOT-18 x NOT-14)', async () => {
    const namespacedSubscriber = create({ namespace: 'tenant-a' });
    const defaultRouter = create();
    namespacedSubscriber.onMessage(() => {});

    await namespacedSubscriber.subscribe('redisTransport-presence-namespaced');

    await expect(
      defaultRouter.receivers(['redisTransport-presence-namespaced'])
    ).resolves.toEqual({ 'redisTransport-presence-namespaced': 0 });

    const otherNamespaced = create({ namespace: 'tenant-a' });
    await expect(
      otherNamespaced.receivers(['redisTransport-presence-namespaced'])
    ).resolves.toEqual({ 'redisTransport-presence-namespaced': 1 });
  });

  it('surfaces connection errors via onError instead of throwing', async () => {
    const onError = jest.fn();
    const transport = redisTransport('redis://127.0.0.1:1');
    transports.push(transport);
    transport.onError(onError);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (onError.mock.calls.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    expect(onError).toHaveBeenCalled();
  });

  it('close() waits for both Redis connections to fully disconnect, not just fire-and-forget', async () => {
    const transport = new RedisTransportImpl(REDIS_URL);
    // Not pushed to `transports` — this test calls close() itself.

    await transport.subscribe('redisTransport-close-waits');
    await transport.close();

    expect(transport['publisher'].status).toBe('end');
    expect(transport['subscriber'].status).toBe('end');
  });

  it('close() still resolves, bounded, for a transport that never successfully connected', async () => {
    const transport = redisTransport('redis://127.0.0.1:1');
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest transports/redisTransport.test.ts`
Expected: FAIL — `Cannot find module './redisTransport'`

- [ ] **Step 3: Implement `redisTransport()`**

Create `packages/core/src/transports/redisTransport.ts`:

```typescript
import Redis from 'ioredis';
import type { NetiflyTransport, UserId } from '../types';
import { disconnectRedis } from '../redisDisconnect';

export interface RedisTransportOptions {
  /**
   * Scopes this transport's channel names to `netifly:<namespace>:user:<id>`
   * instead of the default `netifly:user:<id>`. Set this when multiple apps
   * (or environments, e.g. staging vs. prod) share one Redis instance —
   * common on Upstash/Redis Cloud free tiers — so they don't receive each
   * other's notifications. Omit for the default, unnamespaced shape.
   */
  namespace?: string;
}

const CHANNEL_PREFIX = 'netifly:';
const CHANNEL_USER_SEGMENT = 'user:';
const MAX_USER_ID_LENGTH = 256;

function assertValidUserId(userId: UserId): void {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
    throw new Error(
      `Netifly: userId must be a non-empty string of at most ${MAX_USER_ID_LENGTH} characters`
    );
  }
}

function channelPrefix(namespace?: string): string {
  return namespace
    ? `${CHANNEL_PREFIX}${namespace}:${CHANNEL_USER_SEGMENT}`
    : `${CHANNEL_PREFIX}${CHANNEL_USER_SEGMENT}`;
}

export function channelName(userId: UserId, namespace?: string): string {
  assertValidUserId(userId);
  return `${channelPrefix(namespace)}${userId}`;
}

/**
 * Redis pub/sub-backed NetiflyTransport — the default. Exported as a class
 * (rather than a closure, like memoryTransport()) so its own test file can
 * assert on internal ioredis connection state via bracket-notation access
 * to `publisher`/`subscriber` — the same pattern the old RedisRouter class
 * used. Prefer the `redisTransport()` factory function everywhere else.
 *
 * Ref-counting for overlapping subscribe()/unsubscribe() calls is NOT
 * handled here — that's RefCountedTransport's job, applied by
 * createNetifly() around whichever raw transport it's given (NOT-20 design
 * spec §5), so this implementation assumes each subscribe()/unsubscribe()
 * call it receives is already deduplicated.
 */
export class RedisTransportImpl implements NetiflyTransport {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly namespace: string | undefined;
  private onMessageCb: ((userId: UserId, message: string) => void) | undefined;

  constructor(url: string, options: RedisTransportOptions = {}) {
    this.namespace = options.namespace;
    this.publisher = new Redis(url);
    // enableReadyCheck is disabled here because ioredis's own connection
    // handshake sends an INFO command to verify readiness, and that command
    // can race against our SUBSCRIBE call below. If SUBSCRIBE reaches the
    // server first, the connection enters subscriber-only mode and Redis
    // rejects the in-flight INFO command ("ERR Can't execute 'info'"), which
    // ioredis then reports as a fatal connection error. This connection is
    // subscribe-only, so the readiness check serves no purpose here.
    this.subscriber = new Redis(url, { enableReadyCheck: false });

    this.subscriber.on('message', (channel, message) => {
      const userId = this.userIdFromChannel(channel);
      if (userId !== null) {
        this.onMessageCb?.(userId, message);
      }
    });
  }

  private userIdFromChannel(channel: string): UserId | null {
    const prefix = channelPrefix(this.namespace);
    return channel.startsWith(prefix) ? channel.slice(prefix.length) : null;
  }

  private channelFor(userId: UserId): string {
    return channelName(userId, this.namespace);
  }

  async subscribe(userId: UserId): Promise<void> {
    await this.subscriber.subscribe(this.channelFor(userId));
  }

  async unsubscribe(userId: UserId): Promise<void> {
    await this.subscriber.unsubscribe(this.channelFor(userId));
  }

  async publish(userId: UserId, message: string): Promise<{ receivers: number }> {
    const receivers = await this.publisher.publish(this.channelFor(userId), message);
    return { receivers };
  }

  // One NUMSUB call for many channels (NOT-14), rather than looping a
  // single-channel call per userId. Redis replies with a flat
  // [channel1, count1, channel2, count2, ...] array in the same order the
  // channels were requested, so the reply is zipped back to the original
  // userIds by index. Run on the publisher, not the subscriber — the
  // subscriber connection may be in RESP2 subscribe-mode depending on
  // active subscriptions, while the publisher is always a plain client safe
  // for arbitrary commands.
  async receivers(userIds: UserId[]): Promise<Record<UserId, number>> {
    if (userIds.length === 0) return {};

    const channels = userIds.map((userId) => this.channelFor(userId));
    const reply = (await this.publisher.call('PUBSUB', 'NUMSUB', ...channels)) as (
      | string
      | number
    )[];

    const counts: Record<UserId, number> = {};
    userIds.forEach((userId, index) => {
      counts[userId] = reply[index * 2 + 1] as number;
    });
    return counts;
  }

  onMessage(cb: (userId: UserId, message: string) => void): void {
    this.onMessageCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.publisher.on('error', cb);
    this.subscriber.on('error', cb);
  }

  async close(): Promise<void> {
    await Promise.all([disconnectRedis(this.publisher), disconnectRedis(this.subscriber)]);
  }
}

export function redisTransport(url: string, options?: RedisTransportOptions): NetiflyTransport {
  return new RedisTransportImpl(url, options);
}
```

- [ ] **Step 4: Delete the superseded files**

```bash
git rm packages/core/src/redisRouter.ts packages/core/src/redisRouter.test.ts
```

- [ ] **Step 5: Fix the one real dependency on the old module path**

In `packages/core/src/netiflyPublisher.ts`, change:

```typescript
import { channelName } from './redisRouter';
```

to:

```typescript
import { channelName } from './transports/redisTransport';
```

(This is the only behavioral dependency outside `netiflyServer.ts`/its test on the old file — `NetiflyPublisher` itself is otherwise untouched per this ticket's non-goals.)

- [ ] **Step 6: Fix the stale doc-comment path reference**

In `packages/core/src/redisDisconnect.ts`, change the comment referencing:

```
 * retrying against an unreachable host — see `redisRouter.test.ts`'s
```

to:

```
 * retrying against an unreachable host — see `transports/redisTransport.test.ts`'s
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/core && npx jest transports/redisTransport.test.ts`
Expected: PASS (4 `channelName` tests + 8 contract-suite tests + 6 Redis-specific tests)

Also run the full suite once here to confirm nothing else broke from the delete/rename (expect only `netiflyServer.test.ts` to still be red at this point — Task 4 fixes it):

Run: `cd packages/core && npx jest`
Expected: `transports/redisTransport.test.ts`, `transports/memoryTransport.test.ts`, `transports/refCountedTransport.test.ts`, and `netiflyPublisher.test.ts` all PASS (Step 5 above already repointed `netiflyPublisher.ts`'s import, so it isn't affected by the delete). `netiflyServer.test.ts` FAILS to even load (`Cannot find module './redisRouter'` — it imports that path directly, and `netiflyServer.ts` itself still does too) — expected until Task 4.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/transports/redisTransport.ts packages/core/src/transports/redisTransport.test.ts packages/core/src/netiflyPublisher.ts packages/core/src/redisDisconnect.ts
git commit -m "$(cat <<'EOF'
feat(core): extract redisTransport() from RedisRouter (NOT-20)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire `createNetifly()` to the transport abstraction

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/netiflyServer.ts`
- Test: `packages/core/src/netiflyServer.test.ts`

**Interfaces:**
- Consumes: `NetiflyTransport` (Task 1), `RefCountedTransport` (Task 2), `redisTransport` (Task 3).
- Produces: `CreateNetiflyOptions.transport?: NetiflyTransport`.

- [ ] **Step 1: Add the `transport` option to `types.ts`**

In `packages/core/src/types.ts`, add this field to `CreateNetiflyOptions`, right after the existing `redisUrl?: string;` field:

```typescript
  /**
   * The transport used to move messages between connections and across
   * server instances. Defaults to `redisTransport(redisUrl, { namespace })`
   * built from `redisUrl`/`REDIS_URL` and `namespace` below. Passing both
   * `transport` and `namespace` throws synchronously at construction —
   * `namespace` only has meaning when this package builds the Redis
   * transport for you; pass it directly to `redisTransport(url, { namespace })`
   * instead when constructing a transport explicitly.
   */
  transport?: NetiflyTransport;
```

Add `NetiflyTransport` to the same file's own type list where it's used — no import needed here, since `types.ts` is where `NetiflyTransport` is itself defined (Task 1).

- [ ] **Step 2: Write the failing tests**

Add to `packages/core/src/netiflyServer.test.ts`, inside the existing `describe('createNetifly', ...)` block (find it by searching for an existing `it('is a no-op when sending to a user with no connections anywhere'` — add these nearby):

```typescript
  it('throws synchronously when both transport and namespace are passed', () => {
    const httpServer = http.createServer();
    expect(() =>
      createNetifly({
        server: httpServer,
        resolveUserId: () => 'x',
        transport: memoryTransport(),
        namespace: 'staging',
      })
    ).toThrow(/pass .*namespace.* to redisTransport\(\) directly/);
  });

  // Regression coverage for a test that only ever lived in
  // redisRouter.test.ts ("rejects a non-serializable payload with a clear
  // error", testing RedisRouter.publish directly) — deleted in Task 3 since
  // serialization moved out of the transport and into netiflyServer's own
  // send() path (see serializeEnvelope, Step 4.6-4.8 below). Re-asserted
  // here at the level a caller actually observes it.
  it('rejects a non-serializable payload with a clear error', async () => {
    const server = await startTestServer(() => 'netiflyServer-circular');
    servers.push(server);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(server.netifly.send('netiflyServer-circular', circular)).rejects.toThrow(
      'Netifly: payload for user "netiflyServer-circular" is not JSON-serializable'
    );
  });

  it('works end-to-end with an explicit memoryTransport(), with no Redis involved', async () => {
    const userId = 'netiflyServer-memory-transport';
    const server = await startTestServer(() => userId, { transport: memoryTransport() });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    const result = await server.netifly.send(userId, { type: 'x' });
    const envelope = JSON.parse(await messagePromise);

    expect(result).toEqual({ delivered: true, instances: 1 });
    expect(envelope.data).toEqual({ type: 'x' });
    await expect(server.netifly.isOnline(userId)).resolves.toBe(true);
  });
```

Add the import at the top of the file, next to the existing `import { createNetifly } from './netiflyServer';` line:

```typescript
import { memoryTransport } from './transports/memoryTransport';
```

Replace the existing `RedisRouter` import — change:

```typescript
import { RedisRouter, channelName } from './redisRouter';
```

to:

```typescript
import { RefCountedTransport } from './transports/refCountedTransport';
import { channelName } from './transports/redisTransport';
```

Retarget the NOT-5 race-condition test to spy at the new seam. Find (around line 733-748):

```typescript
  it('does not lose messages when a second connection for the same user arrives while the first is still subscribing and then closes', async () => {
    const userId = 'netiflyServer-race';
    const originalSubscribe = RedisRouter.prototype.subscribe;
    const releases: Array<() => void> = [];
    let callIndex = 0;

    const subscribeSpy = jest
      .spyOn(RedisRouter.prototype, 'subscribe')
      .mockImplementation(function (this: RedisRouter, subscribedUserId: string) {
        const index = callIndex++;
        const realPromise = originalSubscribe.call(this, subscribedUserId);
        if (index > 1) return realPromise;
        return new Promise<void>((resolve, reject) => {
          releases[index] = () => realPromise.then(resolve, reject);
        });
      });
```

Replace with:

```typescript
  it('does not lose messages when a second connection for the same user arrives while the first is still subscribing and then closes', async () => {
    const userId = 'netiflyServer-race';
    const originalSubscribe = RefCountedTransport.prototype.subscribe;
    const releases: Array<() => void> = [];
    let callIndex = 0;

    const subscribeSpy = jest
      .spyOn(RefCountedTransport.prototype, 'subscribe')
      .mockImplementation(function (this: RefCountedTransport, subscribedUserId: string) {
        const index = callIndex++;
        const realPromise = originalSubscribe.call(this, subscribedUserId);
        if (index > 1) return realPromise;
        return new Promise<void>((resolve, reject) => {
          releases[index] = () => realPromise.then(resolve, reject);
        });
      });
```

(Same technique, retargeted one layer down: `netiflyServer` now calls `this.transport.subscribe()` where `this.transport` is a `RefCountedTransport`, so that's the seam to spy on — its `subscribe()` is exactly what "makes an overlapping subscribe() resolve without ever touching Redis, it just bumps a ref count," matching the test's own comment above it. That surrounding comment block can stay as-is; it already describes `RefCountedTransport`'s actual behavior, just written before this rename.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/core && npx jest netiflyServer.test.ts`
Expected: FAIL — `Cannot find module './redisRouter'` (from `netiflyServer.ts`'s still-old import) and/or `transport`/`memoryTransport` not recognized.

- [ ] **Step 4: Implement — wire `netiflyServer.ts`**

In `packages/core/src/netiflyServer.ts`:

1. Replace the `RedisRouter` import and add the two new ones. Change:

```typescript
import { ConnectionRegistry } from './connectionRegistry';
import { RedisRouter } from './redisRouter';
import { startHeartbeat } from './heartbeat';
```

to:

```typescript
import { ConnectionRegistry } from './connectionRegistry';
import { redisTransport } from './transports/redisTransport';
import { RefCountedTransport } from './transports/refCountedTransport';
import { startHeartbeat } from './heartbeat';
```

2. Add `NetiflyTransport` to the `import type { ... } from './types';` block (alphabetical, matching the existing list's order — it goes right after `NetiflyInstance` and before `RejectInfo`).

3. Replace the `router` field with `transport`. Change:

```typescript
  private readonly router: RedisRouter;
```

to:

```typescript
  private readonly transport: NetiflyTransport;
```

4. Replace the constructor's Redis-only setup with transport construction. Change:

```typescript
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error(
        'Netifly: no redisUrl provided and REDIS_URL is not set. Pass { redisUrl } to createNetifly() or set the REDIS_URL environment variable.'
      );
    }

    this.router = new RedisRouter({
      redisUrl,
      onMessage: (userId, rawMessage) => this.deliverLocally(userId, rawMessage),
      onError: (error) => this.emitError(error),
      namespace: options.namespace,
    });
```

to:

```typescript
    if (options.transport && options.namespace !== undefined) {
      throw new Error(
        'Netifly: pass `namespace` to redisTransport() directly when using an explicit `transport` option — ' +
          'createNetifly({ namespace }) only applies to the redisUrl-built default transport.'
      );
    }

    let raw: NetiflyTransport;
    if (options.transport) {
      raw = options.transport;
    } else {
      const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error(
          'Netifly: no redisUrl provided and REDIS_URL is not set. Pass { redisUrl } to createNetifly() or set the REDIS_URL environment variable.'
        );
      }
      raw = redisTransport(redisUrl, { namespace: options.namespace });
    }
    this.transport = new RefCountedTransport(raw);
    this.transport.onMessage((userId, message) => this.deliverLocally(userId, message));
    this.transport.onError((error) => this.emitError(error));
```

5. Replace both `this.router.subscribe`/`this.router.unsubscribe` calls in `registerConnection`. Change:

```typescript
    ws.on('close', () => {
      this.registry.remove(userId, ws);
      if (subscribed) {
        subscribed = false;
        this.emit('disconnect', userId);
        this.router.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      }
    });

    try {
      await this.router.subscribe(userId);
    } catch (error) {
      this.emitError(error);
      ws.terminate();
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      // Closed while the SUBSCRIBE was in flight. The 'close' listener above
      // already ran (before `subscribed` was set, so it didn't pair an
      // unsubscribe) — do it here instead.
      this.router.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      return;
    }
```

to:

```typescript
    ws.on('close', () => {
      this.registry.remove(userId, ws);
      if (subscribed) {
        subscribed = false;
        this.emit('disconnect', userId);
        this.transport.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      }
    });

    try {
      await this.transport.subscribe(userId);
    } catch (error) {
      this.emitError(error);
      ws.terminate();
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      // Closed while the SUBSCRIBE was in flight. The 'close' listener above
      // already ran (before `subscribed` was set, so it didn't pair an
      // unsubscribe) — do it here instead.
      this.transport.unsubscribe(userId).catch((error: unknown) => this.emitError(error));
      return;
    }
```

6. Add a serialization helper, and use it from both places an envelope gets published. Add this private method right after `buildEnvelope`:

```typescript
  private buildEnvelope<T>(type: string, data: T): Envelope<T> {
    return { v: ENVELOPE_VERSION, id: this.ulid(), type, data, ts: Date.now() };
  }

  private serializeEnvelope(userId: UserId, envelope: Envelope<unknown>): string {
    try {
      return JSON.stringify(envelope);
    } catch (error) {
      const message = `Netifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }
  }
```

7. Use it in `handleInboundFrame`'s relay publish. Change:

```typescript
    const relayEnvelope = this.buildEnvelope(relayType, relayData);
    this.router.publish(userId, relayEnvelope).catch((error: unknown) => this.emitError(error));
```

to:

```typescript
    const relayEnvelope = this.buildEnvelope(relayType, relayData);
    const relayMessage = this.serializeEnvelope(userId, relayEnvelope);
    this.transport.publish(userId, relayMessage).catch((error: unknown) => this.emitError(error));
```

8. Use it in `sendInternal`. Change:

```typescript
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);
    const instances = await this.router.publish(userId, envelope);
    return { delivered: instances > 0, instances };
```

to:

```typescript
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);
    const message = this.serializeEnvelope(userId, envelope);
    const { receivers } = await this.transport.publish(userId, message);
    return { delivered: receivers > 0, instances: receivers };
```

9. Replace `isOnline`/`whoIsOnline`. Change:

```typescript
  async isOnline(userId: UserId): Promise<boolean> {
    return (await this.router.numSubscribers(userId)) > 0;
  }

  async whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>> {
    const counts = await this.router.numSubscribersMany(userIds);
    const online: Record<UserId, boolean> = {};
    for (const userId of userIds) {
      online[userId] = counts[userId] > 0;
    }
    return online;
  }
```

to:

```typescript
  async isOnline(userId: UserId): Promise<boolean> {
    const counts = await this.transport.receivers([userId]);
    return counts[userId] > 0;
  }

  async whoIsOnline(userIds: UserId[]): Promise<Record<UserId, boolean>> {
    const counts = await this.transport.receivers(userIds);
    const online: Record<UserId, boolean> = {};
    for (const userId of userIds) {
      online[userId] = counts[userId] > 0;
    }
    return online;
  }
```

10. Replace the `close()` method's router shutdown. Change:

```typescript
    await this.router.close();
```

to:

```typescript
    await this.transport.close();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx jest netiflyServer.test.ts`
Expected: PASS (every existing test, plus the two new ones from Step 2)

Then run the whole package once more to confirm the full picture is green:

Run: `cd packages/core && npx jest`
Expected: PASS, all suites (`transports/*.test.ts`, `netiflyServer.test.ts`, `netiflyPublisher.test.ts`, `connectionRegistry.test.ts`, `heartbeat.test.ts`, `inboundFrame.test.ts`, `rateLimiter.test.ts`)

- [ ] **Step 6: Verify the whole package still type-checks**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "$(cat <<'EOF'
feat(core): wire createNetifly() to the transport abstraction (NOT-20)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Package exports and documentation (README + GitBook)

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `README.md`
- Modify: `docs/site/reference/core.md`

**Interfaces:**
- Consumes: `NetiflyTransport` (Task 1), `redisTransport`, `RedisTransportOptions` (Task 3), `memoryTransport` (Task 1).

- [ ] **Step 1: Add the new exports**

In `packages/core/src/index.ts`, change:

```typescript
export { createNetifly } from './netiflyServer';
export { createNetiflyPublisher } from './netiflyPublisher';
export { ENVELOPE_VERSION } from './types';
export type {
  AckInfo,
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  CreateNetiflyPublisherOptions,
  DroppedInfo,
  Envelope,
  EventMap,
  MalformedFrameInfo,
  MalformedFrameReason,
  NetiflyInstance,
  NetiflyPublisher,
  RejectInfo,
  ResolveUserId,
  ResponseInfo,
  SendOrOptions,
  SendResult,
  SentInfo,
  UserId,
} from './types';
```

to:

```typescript
export { createNetifly } from './netiflyServer';
export { createNetiflyPublisher } from './netiflyPublisher';
export { memoryTransport } from './transports/memoryTransport';
export { redisTransport } from './transports/redisTransport';
export { ENVELOPE_VERSION } from './types';
export type {
  AckInfo,
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  CreateNetiflyPublisherOptions,
  DroppedInfo,
  Envelope,
  EventMap,
  MalformedFrameInfo,
  MalformedFrameReason,
  NetiflyInstance,
  NetiflyPublisher,
  NetiflyTransport,
  RejectInfo,
  ResolveUserId,
  ResponseInfo,
  SendOrOptions,
  SendResult,
  SentInfo,
  UserId,
} from './types';
export type { RedisTransportOptions } from './transports/redisTransport';
```

- [ ] **Step 2: Verify the exports compile**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 3: Update the root README's options table**

In `README.md`, change the `createNetifly` options table row for `redisUrl` (find the line starting `| \`redisUrl\` | \`string\` |`) from:

```markdown
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL` if omitted. One of the two **must** be provided — Netifly throws at construction time if neither is set (no default/local fallback). |
```

to:

```markdown
| `redisUrl` | `string` | — | Falls back to `process.env.REDIS_URL` if omitted. Ignored if `transport` is passed. One of `redisUrl`/`REDIS_URL`/`transport` **must** be provided — Netifly throws at construction time if none is set (no default/local fallback). |
| `transport` | `NetiflyTransport` | — | The transport used to move messages between connections and across server instances (see [Transport](#-transport)). Defaults to a Redis transport built from `redisUrl`/`namespace` below. Passing both `transport` and `namespace` throws at construction time. |
```

And change the `namespace` row (find the line starting `| \`namespace\` | \`string\` |`) from:

```markdown
| `namespace` | `string` | — | Scopes Redis channel names to `netifly:<namespace>:user:<id>` instead of the default `netifly:user:<id>` — use this when multiple apps/environments share one Redis instance (see [Redis Configuration](#-redis-configuration)). Defaults to unset (no namespace). |
```

to:

```markdown
| `namespace` | `string` | — | Scopes Redis channel names to `netifly:<namespace>:user:<id>` instead of the default `netifly:user:<id>` — use this when multiple apps/environments share one Redis instance (see [Redis Configuration](#-redis-configuration)). Only meaningful when building the default Redis transport from `redisUrl`; pass it to `redisTransport(url, { namespace })` directly if you're passing `transport` explicitly. Defaults to unset (no namespace). |
```

- [ ] **Step 4: Add a "Transport" section to the README**

In `README.md`, insert a new section right after the "Sharing one Redis instance across apps or environments" subsection and before the `## 🛡️ Security` heading. Find:

```markdown
```ts
createNetifly({ server, resolveUserId, namespace: 'staging' });
```

## 🛡️ Security
```

Replace with:

```markdown
```ts
createNetifly({ server, resolveUserId, namespace: 'staging' });
```

## 🔌 Transport

`createNetifly()` moves messages between connections — and across server instances, in a multi-instance deployment — through a `NetiflyTransport`. Passing `redisUrl` (or setting `REDIS_URL`) is sugar for building the default one: `redisTransport(redisUrl, { namespace })`. Pass `transport` explicitly for more control, or to use a different implementation entirely:

```ts
import { createNetifly, redisTransport, memoryTransport } from '@netiflyjs/core';

// Explicit, namespaced Redis transport — identical to the redisUrl/namespace sugar above.
createNetifly({
  server,
  resolveUserId,
  transport: redisTransport(process.env.REDIS_URL!, { namespace: 'staging' }),
});

// Local development and tests — no Redis required.
createNetifly({ server, resolveUserId, transport: memoryTransport() });
```

`memoryTransport()` is a single-process, dependency-free transport — recommended for running your own app's test suite against Netifly without standing up a real Redis instance. It models exactly one process: it doesn't simulate a multi-instance cluster, so cross-instance behavior (e.g. presence via `isOnline()`/`whoIsOnline()`, or delivery to a connection held by a different server instance) should still be tested against `redisTransport()` if your app depends on it.

## 🛡️ Security
```

- [ ] **Step 5: Update the GitBook site copy**

In `docs/site/reference/core.md`, change the options table (find the line starting `| \`redisUrl\` | — |`) from:

```markdown
| `redisUrl` | — | falls back to `process.env.REDIS_URL`; one of the two is required |
```

to:

```markdown
| `redisUrl` | — | falls back to `process.env.REDIS_URL`; ignored if `transport` is passed |
| `transport` | — | `NetiflyTransport` — `redisTransport(url, { namespace })` (default) or `memoryTransport()` for zero-Redis local dev/tests; see the root README's [Transport](https://github.com/NetiflyJS/netifly#-transport) section |
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts README.md docs/site/reference/core.md
git commit -m "$(cat <<'EOF'
docs(core): export and document the transport abstraction (NOT-20)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
