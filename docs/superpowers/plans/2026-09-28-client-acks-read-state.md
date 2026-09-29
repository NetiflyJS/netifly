# Client Acks and Read State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a connected client acknowledge delivery, mark a notification read, and send an arbitrary-payload response back to the server, with the server exposing `'sent'`/`'delivered'`/`'read'`/`'response'`/`'malformedFrame'` events — all without changing the existing wire envelope.

**Architecture:** `@netiflyjs/core`'s WebSocket server gains an inbound `ws.on('message', ...)` handler (it currently has none) that parses and rate-limits a small discriminated client frame, fires the matching hook exactly once on the receiving instance, and relays a standard-envelope frame (reserved `netifly.*` type) back through the existing per-user Redis channel so a user's other open connections stay in sync — no new Redis channel. `@netiflyjs/client` gains `markRead()`/`respond()` plus an on-by-default auto-ack after every received application envelope.

**Tech Stack:** TypeScript, `ws` (WebSocketServer), `ioredis`, Jest + `ts-jest`, real (non-mocked) Redis + WebSocket connections in tests — this repo's existing convention (see `packages/core/src/netiflyServer.test.ts`).

**Spec:** [docs/superpowers/specs/2026-09-28-client-acks-read-state-design.md](../specs/2026-09-28-client-acks-read-state-design.md)

## Global Constraints

- Non-breaking: the existing envelope shape `{ v, id, type, data, ts }` is unchanged (spec §2).
- `maxInboundFramesPerSecond` defaults to `20` (spec §7).
- `autoAck` defaults to `true` (spec §8).
- `netifly.` is a reserved envelope `type` prefix for relay frames; auto-ack must skip it (spec §5, §8).
- No new Redis channel — relay frames reuse the existing `netifly:user:<id>` channel and its subscribe/unsubscribe lifecycle (spec §6).
- `NetiflyPublisher` gains `on('sent', ...)` only — never `'delivered'`/`'read'`/`'response'` (spec §4 non-goals).
- No unread-count helper in this ticket (spec §4 non-goals).
- `@netiflyjs/client`'s bundled+minified+gzipped size must stay under its existing 3 KB `size-limit` budget (`packages/client/package.json`).
- A malformed or rate-limited inbound frame is dropped and counted via `'malformedFrame'` — it must never throw, crash the process, or close the connection (spec §9).

## Review Focus

- A binary (non-text) inbound WebSocket frame must be dropped as malformed, not crash the connection — covered in Task 3.
- A `response` frame whose `payload` is a literal `null` must be accepted (the key is present), not rejected as `invalidShape` — covered in Task 1.
- `maxInboundFramesPerSecond` is one shared budget per connection across `ack`/`read`/`response` frames, not a separate counter per frame kind — covered in Task 4.
- `TokenBucket` configured with a rate of `0` must reject every attempt, with no divide-by-zero or accidental first free token — covered in Task 2.
- A malformed or rate-limited frame must never close the connection — the same socket must keep working normally for subsequent valid traffic — covered in Task 3.

---

## File Structure

- `packages/core/src/inboundFrame.ts` (new) — pure parsing/validation of a client-sent frame into `InboundFrame | parse failure`. No I/O, easy to unit test exhaustively.
- `packages/core/src/rateLimiter.ts` (new) — a small per-connection `TokenBucket` used to bound inbound frame rate. No I/O.
- `packages/core/src/netiflyServer.ts` (modify) — wires the two files above into `registerConnection`'s socket handling; adds `'sent'` to `sendInternal`.
- `packages/core/src/netiflyPublisher.ts` (modify) — becomes an `EventEmitter` to support `'sent'`.
- `packages/core/src/types.ts` (modify) — new option (`maxInboundFramesPerSecond`) and new event payload types/overloads.
- `packages/core/src/index.ts` (modify) — exports the new types.
- `packages/core/README.md` (modify) — documents the new option and events.
- `packages/client/src/client.ts` (modify) — `markRead()`, `respond()`, auto-ack.
- `packages/client/src/types.ts` (modify) — new `autoAck` option.

---

### Task 1: Inbound frame parser

**Files:**
- Create: `packages/core/src/inboundFrame.ts`
- Test: `packages/core/src/inboundFrame.test.ts`

**Interfaces:**
- Produces: `parseInboundFrame(raw: string): ParsedInboundFrame`, `InboundFrame` (`{ type: 'ack'|'read'; id: string } | { type: 'response'; id: string; payload: unknown }`), `ParsedInboundFrame` (`{ ok: true; frame: InboundFrame } | { ok: false; reason: 'invalidJson' | 'invalidShape' }`). Task 3 imports `parseInboundFrame` and these types.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/inboundFrame.test.ts
import { parseInboundFrame } from './inboundFrame';

describe('parseInboundFrame', () => {
  it('parses a valid ack frame', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'ack', id: 'notif-1' }));
    expect(result).toEqual({ ok: true, frame: { type: 'ack', id: 'notif-1' } });
  });

  it('parses a valid read frame', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'read', id: 'notif-2' }));
    expect(result).toEqual({ ok: true, frame: { type: 'read', id: 'notif-2' } });
  });

  it('parses a valid response frame with an object payload', () => {
    const result = parseInboundFrame(
      JSON.stringify({ type: 'response', id: 'notif-3', payload: { choice: 'accept' } })
    );
    expect(result).toEqual({
      ok: true,
      frame: { type: 'response', id: 'notif-3', payload: { choice: 'accept' } },
    });
  });

  it('accepts a response frame with a null payload', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'response', id: 'notif-4', payload: null }));
    expect(result).toEqual({ ok: true, frame: { type: 'response', id: 'notif-4', payload: null } });
  });

  it('accepts a response frame with a primitive payload', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'response', id: 'notif-5', payload: 42 }));
    expect(result).toEqual({ ok: true, frame: { type: 'response', id: 'notif-5', payload: 42 } });
  });

  it('rejects invalid JSON', () => {
    expect(parseInboundFrame('not json')).toEqual({ ok: false, reason: 'invalidJson' });
  });

  it('rejects a JSON array', () => {
    expect(parseInboundFrame('[1,2,3]')).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects JSON null', () => {
    expect(parseInboundFrame('null')).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects a missing type', () => {
    expect(parseInboundFrame(JSON.stringify({ id: 'x' }))).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects an unknown type value', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'delete', id: 'x' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects a missing id', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'ack' }))).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects a non-string id', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'ack', id: 42 }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects an empty-string id', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'ack', id: '' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects a response frame missing the payload key', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'response', id: 'x' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest inboundFrame.test.ts`
Expected: FAIL — `Cannot find module './inboundFrame'`

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/inboundFrame.ts

/** A validated client → server control frame (see NOT-30 spec §5). */
export type InboundFrame =
  | { type: 'ack'; id: string }
  | { type: 'read'; id: string }
  | { type: 'response'; id: string; payload: unknown };

export type InboundFrameParseFailureReason = 'invalidJson' | 'invalidShape';

export type ParsedInboundFrame =
  | { ok: true; frame: InboundFrame }
  | { ok: false; reason: InboundFrameParseFailureReason };

const ACK_OR_READ_TYPES = new Set(['ack', 'read']);

/**
 * Parses and validates one raw inbound WebSocket text frame into an
 * `InboundFrame`. Never throws — every failure is reported as
 * `{ ok: false, reason }` so the caller can count it via the
 * `'malformedFrame'` event instead of crashing the connection.
 */
export function parseInboundFrame(raw: string): ParsedInboundFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalidJson' };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalidShape' };
  }

  const { type, id } = value as { type?: unknown; id?: unknown };
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, reason: 'invalidShape' };
  }

  if (typeof type === 'string' && ACK_OR_READ_TYPES.has(type)) {
    return { ok: true, frame: { type: type as 'ack' | 'read', id } };
  }

  if (type === 'response') {
    if (!('payload' in value)) {
      return { ok: false, reason: 'invalidShape' };
    }
    return { ok: true, frame: { type: 'response', id, payload: (value as { payload: unknown }).payload } };
  }

  return { ok: false, reason: 'invalidShape' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest inboundFrame.test.ts`
Expected: PASS (all 14 cases)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/inboundFrame.ts packages/core/src/inboundFrame.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add inbound client frame parser for ack/read/response (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Per-connection rate limiter

**Files:**
- Create: `packages/core/src/rateLimiter.ts`
- Test: `packages/core/src/rateLimiter.test.ts`

**Interfaces:**
- Produces: `class TokenBucket { constructor(ratePerSecond: number, now?: number); tryRemoveToken(now?: number): boolean }`. Task 4 imports `TokenBucket`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/rateLimiter.test.ts
import { TokenBucket } from './rateLimiter';

describe('TokenBucket', () => {
  it('allows up to ratePerSecond attempts at the same instant', () => {
    const bucket = new TokenBucket(5, 0);
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryRemoveToken(0)).toBe(true);
    }
    expect(bucket.tryRemoveToken(0)).toBe(false);
  });

  it('refills to full capacity after a full second has elapsed', () => {
    const bucket = new TokenBucket(3, 0);
    expect(bucket.tryRemoveToken(0)).toBe(true);
    expect(bucket.tryRemoveToken(0)).toBe(true);
    expect(bucket.tryRemoveToken(0)).toBe(true);
    expect(bucket.tryRemoveToken(0)).toBe(false);

    expect(bucket.tryRemoveToken(1000)).toBe(true);
    expect(bucket.tryRemoveToken(1000)).toBe(true);
    expect(bucket.tryRemoveToken(1000)).toBe(true);
    expect(bucket.tryRemoveToken(1000)).toBe(false);
  });

  it('refills partially, proportional to elapsed time', () => {
    const bucket = new TokenBucket(10, 0);
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryRemoveToken(0)).toBe(true);
    }
    expect(bucket.tryRemoveToken(0)).toBe(false);

    // 500ms at 10/sec refills ~5 tokens.
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(true);
    expect(bucket.tryRemoveToken(500)).toBe(false);
  });

  it('always rejects when configured with a rate of 0', () => {
    const bucket = new TokenBucket(0, 0);
    expect(bucket.tryRemoveToken(0)).toBe(false);
    expect(bucket.tryRemoveToken(1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest rateLimiter.test.ts`
Expected: FAIL — `Cannot find module './rateLimiter'`

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/rateLimiter.ts

/**
 * A simple continuous-refill token bucket, one per WebSocket connection, used
 * to bound how many inbound client frames (ack/read/response) a single
 * connection may send per second (see NOT-30 spec §9). `now` is an injectable
 * clock, defaulting to `Date.now()`, purely so tests can be deterministic
 * without real sleeps.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(ratePerSecond: number, now: number = Date.now()) {
    this.capacity = ratePerSecond;
    this.refillPerMs = ratePerSecond / 1000;
    this.tokens = ratePerSecond;
    this.lastRefillAt = now;
  }

  tryRemoveToken(now: number = Date.now()): boolean {
    const elapsedMs = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefillAt = now;

    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest rateLimiter.test.ts`
Expected: PASS (all 4 cases)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/rateLimiter.ts packages/core/src/rateLimiter.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add per-connection token bucket rate limiter (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Server emits `delivered`/`read`/`response`/`malformedFrame`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/netiflyServer.ts`
- Test: `packages/core/src/netiflyServer.test.ts`

**Interfaces:**
- Consumes: `parseInboundFrame`, `InboundFrame` from Task 1 (`./inboundFrame`).
- Produces: `AckInfo { userId: UserId; id: string; ts: number }`, `ResponseInfo { userId: UserId; id: string; payload: unknown; ts: number }`, `MalformedFrameReason`, `MalformedFrameInfo { userId: UserId; reason: MalformedFrameReason }` in `types.ts`. `NetiflyInstance` gains `on`/`once` for `'delivered' | 'read'` → `AckInfo`, `'response'` → `ResponseInfo`, `'malformedFrame'` → `MalformedFrameInfo`. Tasks 4–6 build on this.

- [ ] **Step 1: Write the failing tests**

Add a generic event-waiting helper and the new test cases to `packages/core/src/netiflyServer.test.ts`. Add this helper right after the existing `onceEvent` function (around line 101):

```typescript
// Generic counterpart to onceEvent() above, for the new events that carry a
// payload ('delivered' | 'read' | 'response' | 'malformedFrame' | 'sent').
function onceInfo<T>(emitter: NetiflyInstance, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event as never, (info: T) => resolve(info)));
}
```

Add these `it(...)` blocks inside the existing `describe('createNetifly', ...)` block, anywhere after the other tests:

```typescript
  it('emits "delivered" when a client sends an ack frame', async () => {
    const server = await startTestServer(() => 'netiflyServer-ack');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const deliveredPromise = onceInfo<{ userId: string; id: string; ts: number }>(
      server.netifly,
      'delivered'
    );
    client.send(JSON.stringify({ type: 'ack', id: 'notif-1' }));

    const info = await deliveredPromise;
    expect(info.userId).toBe('netiflyServer-ack');
    expect(info.id).toBe('notif-1');
    expect(typeof info.ts).toBe('number');
  });

  it('emits "read" when a client sends a read frame', async () => {
    const server = await startTestServer(() => 'netiflyServer-read');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const readPromise = onceInfo<{ userId: string; id: string; ts: number }>(server.netifly, 'read');
    client.send(JSON.stringify({ type: 'read', id: 'notif-2' }));

    const info = await readPromise;
    expect(info).toMatchObject({ userId: 'netiflyServer-read', id: 'notif-2' });
  });

  it('emits "response" with the client-supplied payload', async () => {
    const server = await startTestServer(() => 'netiflyServer-response');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const responsePromise = onceInfo<{ userId: string; id: string; payload: unknown; ts: number }>(
      server.netifly,
      'response'
    );
    client.send(JSON.stringify({ type: 'response', id: 'notif-3', payload: { choice: 'accept' } }));

    const info = await responsePromise;
    expect(info).toMatchObject({
      userId: 'netiflyServer-response',
      id: 'notif-3',
      payload: { choice: 'accept' },
    });
  });

  it('drops invalid JSON and emits "malformedFrame" with reason "invalidJson"', async () => {
    const server = await startTestServer(() => 'netiflyServer-malformed-json');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const malformedPromise = onceInfo<{ userId: string; reason: string }>(server.netifly, 'malformedFrame');
    client.send('not json');

    const info = await malformedPromise;
    expect(info).toEqual({ userId: 'netiflyServer-malformed-json', reason: 'invalidJson' });
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a binary frame as malformed instead of crashing the connection', async () => {
    const server = await startTestServer(() => 'netiflyServer-malformed-binary');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const malformedPromise = onceInfo<{ userId: string; reason: string }>(server.netifly, 'malformedFrame');
    client.send(Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const info = await malformedPromise;
    expect(info.userId).toBe('netiflyServer-malformed-binary');
    expect(['invalidJson', 'invalidShape']).toContain(info.reason);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a wrong-shape frame and keeps the connection working normally', async () => {
    const server = await startTestServer(() => 'netiflyServer-malformed-shape');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const malformedPromise = onceInfo<{ userId: string; reason: string }>(server.netifly, 'malformedFrame');
    client.send(JSON.stringify({ type: 'unknown-kind', id: 'x' }));

    const info = await malformedPromise;
    expect(info).toEqual({ userId: 'netiflyServer-malformed-shape', reason: 'invalidShape' });

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-malformed-shape', { ok: true });
    const envelope = JSON.parse(await messagePromise);
    expect(envelope.data).toEqual({ ok: true });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest netiflyServer.test.ts -t "delivered|read|response|malformed"`
Expected: FAIL — `server.netifly.once is not a function for event "delivered"` or a timeout (no `'delivered'`/`'read'`/`'response'`/`'malformedFrame'` ever fires yet).

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add these new interfaces right after the existing `DroppedInfo` interface (after the block ending `export interface DroppedInfo { userId: UserId; reason: 'maxBufferedBytes'; }`):

```typescript
export interface AckInfo {
  userId: UserId;
  id: string;
  ts: number;
}

export interface ResponseInfo {
  userId: UserId;
  id: string;
  payload: unknown;
  ts: number;
}

export type MalformedFrameReason = 'invalidJson' | 'invalidShape' | 'rateLimited';

export interface MalformedFrameInfo {
  userId: UserId;
  reason: MalformedFrameReason;
}
```

Still in `types.ts`, extend the `NetiflyInstance` interface's `on`/`once` overloads — add these four lines directly after the existing `on(event: 'dropped', listener: (info: DroppedInfo) => void): this;` line, and the mirrored four after the existing `once(event: 'dropped', ...)` line:

```typescript
  on(event: 'delivered' | 'read', listener: (info: AckInfo) => void): this;
  on(event: 'response', listener: (info: ResponseInfo) => void): this;
  on(event: 'malformedFrame', listener: (info: MalformedFrameInfo) => void): this;
```

```typescript
  once(event: 'delivered' | 'read', listener: (info: AckInfo) => void): this;
  once(event: 'response', listener: (info: ResponseInfo) => void): this;
  once(event: 'malformedFrame', listener: (info: MalformedFrameInfo) => void): this;
```

In `packages/core/src/netiflyServer.ts`:

1. Add an import for the parser right after the `import { startHeartbeat } from './heartbeat';` line:

```typescript
import { parseInboundFrame } from './inboundFrame';
```

2. Add `AckInfo`, `MalformedFrameInfo`, `ResponseInfo` to the existing `import type { ... } from './types';` block (alphabetical, matching the existing list's order).

3. Add a `RawData` type import — change the `ws` import line from:

```typescript
import { WebSocket, WebSocketServer } from 'ws';
```

to:

```typescript
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
```

4. In `registerConnection`, attach the new message handler right after the connection is fully registered — change:

```typescript
    subscribed = true;
    this.registry.add(userId, ws);
    this.emit('connect', userId);
  }
```

to:

```typescript
    subscribed = true;
    this.registry.add(userId, ws);
    this.emit('connect', userId);
    ws.on('message', (data) => this.handleInboundFrame(userId, data));
  }
```

5. Add the new private methods right after `registerConnection` (before `private isOriginAllowed`):

```typescript
  private handleInboundFrame(userId: UserId, data: RawData): void {
    const parsed = parseInboundFrame(data.toString());
    if (!parsed.ok) {
      this.emitMalformedFrame({ userId, reason: parsed.reason });
      return;
    }

    const ts = Date.now();
    const frame = parsed.frame;
    if (frame.type === 'ack') {
      this.emit('delivered', { userId, id: frame.id, ts } satisfies AckInfo);
    } else if (frame.type === 'read') {
      this.emit('read', { userId, id: frame.id, ts } satisfies AckInfo);
    } else {
      this.emit('response', { userId, id: frame.id, payload: frame.payload, ts } satisfies ResponseInfo);
    }
  }

  private emitMalformedFrame(info: MalformedFrameInfo): void {
    this.emit('malformedFrame', info);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest netiflyServer.test.ts`
Expected: PASS (all tests, including the pre-existing ones — nothing else should regress)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "$(cat <<'EOF'
feat(core): emit delivered/read/response/malformedFrame from inbound frames (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Per-connection inbound rate limiting

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/netiflyServer.ts`
- Test: `packages/core/src/netiflyServer.test.ts`

**Interfaces:**
- Consumes: `TokenBucket` from Task 2 (`./rateLimiter`).
- Produces: `CreateNetiflyOptions.maxInboundFramesPerSecond?: number`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/netiflyServer.test.ts`:

```typescript
  it('shares the inbound rate-limit budget across ack/read/response frame kinds', async () => {
    const server = await startTestServer(() => 'netiflyServer-rate-limited-mixed', {
      maxInboundFramesPerSecond: 2,
    });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const rateLimitedPromise = onceInfo<{ userId: string; reason: string }>(server.netifly, 'malformedFrame');
    client.send(JSON.stringify({ type: 'ack', id: 'a' }));
    client.send(JSON.stringify({ type: 'read', id: 'b' }));
    client.send(JSON.stringify({ type: 'response', id: 'c', payload: {} }));

    const info = await rateLimitedPromise;
    expect(info).toEqual({ userId: 'netiflyServer-rate-limited-mixed', reason: 'rateLimited' });

    // The connection itself survives being rate-limited — it isn't closed,
    // and normal server → client delivery keeps working on it afterward.
    expect(client.readyState).toBe(WebSocket.OPEN);
    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-rate-limited-mixed', { ok: true });
    const envelope = JSON.parse(await messagePromise);
    expect(envelope.data).toEqual({ ok: true });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx jest netiflyServer.test.ts -t "shares the inbound rate-limit"`
Expected: FAIL — TypeScript error (`maxInboundFramesPerSecond` doesn't exist on the options type) or a timeout since nothing currently rate-limits.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add this option to `CreateNetiflyOptions`, right after the existing `maxConnectionsPerUser?: number;` field (and its doc comment):

```typescript
  /**
   * Max inbound client frames (ack/read/response) accepted per connection,
   * per second, via a simple per-connection token bucket. Frames beyond the
   * limit are dropped and counted via the 'malformedFrame' event (reason
   * 'rateLimited') rather than closing the connection. Defaults to 20.
   */
  maxInboundFramesPerSecond?: number;
```

In `packages/core/src/netiflyServer.ts`:

1. Add the import and default constant. Change:

```typescript
import { parseInboundFrame } from './inboundFrame';
```

to:

```typescript
import { parseInboundFrame } from './inboundFrame';
import { TokenBucket } from './rateLimiter';
```

and add, next to the other `DEFAULT_*` constants:

```typescript
const DEFAULT_MAX_INBOUND_FRAMES_PER_SECOND = 20;
```

2. Add a field and read the option in the constructor. Change:

```typescript
  private readonly maxConnectionsPerUser: number;
```

to:

```typescript
  private readonly maxConnectionsPerUser: number;
  private readonly maxInboundFramesPerSecond: number;
```

and change:

```typescript
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;
```

to:

```typescript
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;
    this.maxInboundFramesPerSecond =
      options.maxInboundFramesPerSecond ?? DEFAULT_MAX_INBOUND_FRAMES_PER_SECOND;
```

3. Create one `TokenBucket` per connection and thread it through. Change:

```typescript
    subscribed = true;
    this.registry.add(userId, ws);
    this.emit('connect', userId);
    ws.on('message', (data) => this.handleInboundFrame(userId, data));
  }
```

to:

```typescript
    subscribed = true;
    this.registry.add(userId, ws);
    this.emit('connect', userId);
    const inboundBucket = new TokenBucket(this.maxInboundFramesPerSecond);
    ws.on('message', (data) => this.handleInboundFrame(userId, data, inboundBucket));
  }
```

4. Check the bucket first in `handleInboundFrame`. Change:

```typescript
  private handleInboundFrame(userId: UserId, data: RawData): void {
    const parsed = parseInboundFrame(data.toString());
```

to:

```typescript
  private handleInboundFrame(userId: UserId, data: RawData, bucket: TokenBucket): void {
    if (!bucket.tryRemoveToken()) {
      this.emitMalformedFrame({ userId, reason: 'rateLimited' });
      return;
    }

    const parsed = parseInboundFrame(data.toString());
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest netiflyServer.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "$(cat <<'EOF'
feat(core): rate-limit inbound client frames per connection (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Relay acks/reads/responses to the user's other connections

**Files:**
- Modify: `packages/core/src/netiflyServer.ts`
- Test: `packages/core/src/netiflyServer.test.ts`

**Interfaces:**
- Consumes: existing `private buildEnvelope<T>(type: string, data: T): Envelope<T>` and `private router: RedisRouter` (with its existing `publish(userId, payload): Promise<number>`) — both already defined in this file.
- Produces: relay envelopes on the wire with reserved types `netifly.ack` / `netifly.read` / `netifly.response`. Task 8 (client auto-ack) depends on this reserved-type contract.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/netiflyServer.test.ts`:

```typescript
  it("relays a delivered ack to the user's other open connections, including the sender", async () => {
    const server = await startTestServer(() => 'netiflyServer-relay-ack');
    servers.push(server);

    const firstConnectedPromise = onceEvent(server.netifly, 'connect');
    const senderClient = await connectClient(server.port);
    clients.push(senderClient);
    await firstConnectedPromise;

    const secondConnectedPromise = onceEvent(server.netifly, 'connect');
    const otherTabClient = await connectClient(server.port);
    clients.push(otherTabClient);
    await secondConnectedPromise;

    const senderRelayPromise = nextMessage(senderClient);
    const otherTabRelayPromise = nextMessage(otherTabClient);
    senderClient.send(JSON.stringify({ type: 'ack', id: 'notif-relay-1' }));

    const senderRelay = JSON.parse(await senderRelayPromise);
    const otherTabRelay = JSON.parse(await otherTabRelayPromise);
    expect(senderRelay).toMatchObject({ type: 'netifly.ack', data: { id: 'notif-relay-1' } });
    expect(otherTabRelay).toMatchObject({ type: 'netifly.ack', data: { id: 'notif-relay-1' } });
  });

  it('relays a read receipt across two server instances via Redis', async () => {
    const serverA = await startTestServer(() => 'netiflyServer-relay-cross-instance');
    const serverB = await startTestServer(() => 'netiflyServer-relay-cross-instance');
    servers.push(serverA, serverB);

    const connectedOnA = onceEvent(serverA.netifly, 'connect');
    const clientOnA = await connectClient(serverA.port);
    clients.push(clientOnA);
    await connectedOnA;

    const connectedOnB = onceEvent(serverB.netifly, 'connect');
    const clientOnB = await connectClient(serverB.port);
    clients.push(clientOnB);
    await connectedOnB;

    const relayOnB = nextMessage(clientOnB);
    clientOnA.send(JSON.stringify({ type: 'read', id: 'notif-relay-2' }));

    const envelope = JSON.parse(await relayOnB);
    expect(envelope).toMatchObject({ type: 'netifly.read', data: { id: 'notif-relay-2' } });
  });

  it('relays a response with its payload to other connections', async () => {
    const server = await startTestServer(() => 'netiflyServer-relay-response');
    servers.push(server);

    const firstConnectedPromise = onceEvent(server.netifly, 'connect');
    const clientA = await connectClient(server.port);
    clients.push(clientA);
    await firstConnectedPromise;

    const secondConnectedPromise = onceEvent(server.netifly, 'connect');
    const clientB = await connectClient(server.port);
    clients.push(clientB);
    await secondConnectedPromise;

    const relayOnB = nextMessage(clientB);
    clientA.send(JSON.stringify({ type: 'response', id: 'notif-relay-3', payload: { choice: 'decline' } }));

    const envelope = JSON.parse(await relayOnB);
    expect(envelope).toMatchObject({
      type: 'netifly.response',
      data: { id: 'notif-relay-3', payload: { choice: 'decline' } },
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest netiflyServer.test.ts -t "relays"`
Expected: FAIL — timeouts, since nothing is published back to the client yet.

- [ ] **Step 3: Implement**

In `packages/core/src/netiflyServer.ts`, replace the body of `handleInboundFrame` (from Task 4) with the version below, which builds and publishes a relay envelope after firing each hook:

```typescript
  private handleInboundFrame(userId: UserId, data: RawData, bucket: TokenBucket): void {
    if (!bucket.tryRemoveToken()) {
      this.emitMalformedFrame({ userId, reason: 'rateLimited' });
      return;
    }

    const parsed = parseInboundFrame(data.toString());
    if (!parsed.ok) {
      this.emitMalformedFrame({ userId, reason: parsed.reason });
      return;
    }

    const ts = Date.now();
    const frame = parsed.frame;
    let relayType: string;
    let relayData: unknown;

    if (frame.type === 'ack') {
      this.emit('delivered', { userId, id: frame.id, ts } satisfies AckInfo);
      relayType = 'netifly.ack';
      relayData = { id: frame.id };
    } else if (frame.type === 'read') {
      this.emit('read', { userId, id: frame.id, ts } satisfies AckInfo);
      relayType = 'netifly.read';
      relayData = { id: frame.id };
    } else {
      this.emit('response', { userId, id: frame.id, payload: frame.payload, ts } satisfies ResponseInfo);
      relayType = 'netifly.response';
      relayData = { id: frame.id, payload: frame.payload };
    }

    const relayEnvelope = this.buildEnvelope(relayType, relayData);
    this.router.publish(userId, relayEnvelope).catch((error: unknown) => this.emitError(error));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest netiflyServer.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "$(cat <<'EOF'
feat(core): relay ack/read/response to a user's other connections (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `'sent'` event on `NetiflyInstance`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/netiflyServer.ts`
- Test: `packages/core/src/netiflyServer.test.ts`

**Interfaces:**
- Produces: `SentInfo { userId: UserId; id: string; type: string; data: unknown }` in `types.ts`; `NetiflyInstance` gains `on`/`once('sent', (info: SentInfo) => void)`. Task 7 reuses `SentInfo` for `NetiflyPublisher`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/netiflyServer.test.ts`:

```typescript
  it('emits "sent" synchronously with the generated envelope id before publishing', async () => {
    const server = await startTestServer(() => 'netiflyServer-sent-hook');
    servers.push(server);

    const sentPromise = onceInfo<{ userId: string; id: string; type: string; data: unknown }>(
      server.netifly,
      'sent'
    );
    const resultPromise = server.netifly.send('netiflyServer-sent-hook', 'export.ready', { url: 'x' });

    const info = await sentPromise;
    expect(info).toMatchObject({
      userId: 'netiflyServer-sent-hook',
      type: 'export.ready',
      data: { url: 'x' },
    });
    expect(typeof info.id).toBe('string');
    await resultPromise;
  });

  it('emits "sent" for sendOr() as well as send()', async () => {
    const server = await startTestServer(() => 'netiflyServer-sent-hook-sendor');
    servers.push(server);

    const sentPromise = onceInfo<{ userId: string; id: string }>(server.netifly, 'sent');
    await server.netifly.sendOr('netiflyServer-sent-hook-sendor', { hi: true }, { offline: () => {} });

    const info = await sentPromise;
    expect(info.userId).toBe('netiflyServer-sent-hook-sendor');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx jest netiflyServer.test.ts -t "emits \"sent\""`
Expected: FAIL — timeout, `'sent'` never fires yet.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add `SentInfo` right after the `MalformedFrameInfo` interface added in Task 3:

```typescript
export interface SentInfo {
  userId: UserId;
  id: string;
  type: string;
  data: unknown;
}
```

Add the overloads to `NetiflyInstance`, right after the `'malformedFrame'` lines added in Task 3 (both `on` and `once`):

```typescript
  on(event: 'sent', listener: (info: SentInfo) => void): this;
```

```typescript
  once(event: 'sent', listener: (info: SentInfo) => void): this;
```

In `packages/core/src/netiflyServer.ts`, add `SentInfo` to the `import type { ... } from './types';` block, then change `sendInternal`:

```typescript
  private async sendInternal<T>(userId: UserId, rest: [T] | [string, T]): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    const type = rest.length === 2 ? rest[0] : 'message';
    const data = rest.length === 2 ? rest[1] : rest[0];
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    const envelope = this.buildEnvelope(type, data);
    const instances = await this.router.publish(userId, envelope);
    return { delivered: instances > 0, instances };
  }
```

to:

```typescript
  private async sendInternal<T>(userId: UserId, rest: [T] | [string, T]): Promise<SendResult> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    const type = rest.length === 2 ? rest[0] : 'message';
    const data = rest.length === 2 ? rest[1] : rest[0];
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);
    const instances = await this.router.publish(userId, envelope);
    return { delivered: instances > 0, instances };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx jest netiflyServer.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "$(cat <<'EOF'
feat(core): emit 'sent' from send()/sendOr() for send-time persistence (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `'sent'` event on `NetiflyPublisher`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/netiflyPublisher.ts`
- Test: `packages/core/src/netiflyPublisher.test.ts`

**Interfaces:**
- Consumes: `SentInfo` from Task 6 (`./types`).
- Produces: `NetiflyPublisher.on`/`once('sent', (info: SentInfo) => void)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/netiflyPublisher.test.ts` (inside `describe('createNetiflyPublisher', ...)`, using the file's existing `publishers` array):

```typescript
  it('emits "sent" synchronously with the generated id before publishing', async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    const sentPromise = new Promise<{ userId: string; id: string; type: string; data: unknown }>(
      (resolve) => publisher.once('sent', (info) => resolve(info))
    );
    await publisher.send('netiflyPublisher-sent-hook', 'export.ready', { url: 'x' });

    const info = await sentPromise;
    expect(info).toMatchObject({
      userId: 'netiflyPublisher-sent-hook',
      type: 'export.ready',
      data: { url: 'x' },
    });
    expect(typeof info.id).toBe('string');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx jest netiflyPublisher.test.ts -t "emits \"sent\""`
Expected: FAIL — TypeScript error (`publisher.once` doesn't exist on `NetiflyPublisher` yet).

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, extend the `NetiflyPublisher` interface — change:

```typescript
export interface NetiflyPublisher<Events extends EventMap = EventMap> {
  send<T>(userId: UserId, payload: T): Promise<SendResult>;
  send<K extends keyof Events & string>(userId: UserId, type: K, data: Events[K]): Promise<SendResult>;
  /**
   * Whether `userId` has a live connection anywhere in the cluster. Same
   * semantics/accuracy caveat as `NetiflyInstance.isOnline`.
   */
  isOnline(userId: UserId): Promise<boolean>;
```

to:

```typescript
export interface NetiflyPublisher<Events extends EventMap = EventMap> {
  send<T>(userId: UserId, payload: T): Promise<SendResult>;
  send<K extends keyof Events & string>(userId: UserId, type: K, data: Events[K]): Promise<SendResult>;
  /** Fires synchronously inside send(), with the generated envelope id, before publishing. */
  on(event: 'sent', listener: (info: SentInfo) => void): this;
  once(event: 'sent', listener: (info: SentInfo) => void): this;
  /**
   * Whether `userId` has a live connection anywhere in the cluster. Same
   * semantics/accuracy caveat as `NetiflyInstance.isOnline`.
   */
  isOnline(userId: UserId): Promise<boolean>;
```

In `packages/core/src/netiflyPublisher.ts`:

1. Add the `EventEmitter` import and extend the class. Change:

```typescript
import Redis from 'ioredis';
import { monotonicFactory } from 'ulid';
```

to:

```typescript
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { monotonicFactory } from 'ulid';
```

and change:

```typescript
import type {
  CreateNetiflyPublisherOptions,
  Envelope,
  EventMap,
  NetiflyPublisher,
  SendResult,
  UserId,
} from './types';

class NetiflyPublisherImpl<Events extends EventMap = EventMap> implements NetiflyPublisher<Events> {
```

to:

```typescript
import type {
  CreateNetiflyPublisherOptions,
  Envelope,
  EventMap,
  NetiflyPublisher,
  SendResult,
  SentInfo,
  UserId,
} from './types';

class NetiflyPublisherImpl<Events extends EventMap = EventMap>
  extends EventEmitter
  implements NetiflyPublisher<Events>
{
```

2. Call `super()` in the constructor. Change:

```typescript
  constructor(options: CreateNetiflyPublisherOptions<Events>) {
    this.namespace = options.namespace;
```

to:

```typescript
  constructor(options: CreateNetiflyPublisherOptions<Events>) {
    super();
    this.namespace = options.namespace;
```

3. Emit `'sent'` in `send()`. Change:

```typescript
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    const envelope = this.buildEnvelope(type, data);

    let serialized: string;
```

to:

```typescript
    (this.validate as ((type: string, data: unknown) => void) | undefined)?.(type, data);
    const envelope = this.buildEnvelope(type, data);
    this.emit('sent', {
      userId,
      id: envelope.id,
      type: envelope.type,
      data: envelope.data,
    } satisfies SentInfo);

    let serialized: string;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx jest netiflyPublisher.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/netiflyPublisher.ts packages/core/src/netiflyPublisher.test.ts
git commit -m "$(cat <<'EOF'
feat(core): emit 'sent' from NetiflyPublisher.send() (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Client SDK — `markRead()`, `respond()`, auto-ack

**Files:**
- Modify: `packages/client/src/types.ts`
- Modify: `packages/client/src/client.ts`
- Test: `packages/client/src/client.test.ts`

**Interfaces:**
- Consumes: server-side `'delivered'`/`'read'`/`'response'` events and `netifly.ack`/`netifly.read`/`netifly.response` relay envelopes from Tasks 3 and 5 (round-trip tests exercise the real `@netiflyjs/core` server, as this test file already does).
- Produces: `NetiflyClient.markRead(id: string): void`, `NetiflyClient.respond(id: string, payload: unknown): void`, `NetiflyClientOptions.autoAck?: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/client/src/client.test.ts`, inside `describe('NetiflyClient', ...)`:

```typescript
  it('auto-acks a received application envelope by default', async () => {
    const server = track(await startServer());
    const client = makeClient(server.port);

    const deliveredPromise = new Promise<{ userId: string; id: string; ts: number }>((resolve) =>
      server.netifly.once('delivered', (info) => resolve(info))
    );

    client.connect();
    await nextState(client, 'open');

    const received = nextEvent(client, 'export.ready');
    await server.netifly.send('alice', 'export.ready', { url: 'https://x' });
    const { envelope } = await received;

    const info = await deliveredPromise;
    expect(info.userId).toBe('alice');
    expect(info.id).toBe(envelope.id);
    expect(typeof info.ts).toBe('number');
  });

  it('does not auto-ack when autoAck is false', async () => {
    const server = track(await startServer());
    const client = makeClient(server.port, { autoAck: false });

    const deliveredCalls: unknown[] = [];
    server.netifly.on('delivered', (info) => deliveredCalls.push(info));

    client.connect();
    await nextState(client, 'open');

    const received = nextEvent(client, 'export.ready');
    await server.netifly.send('alice', 'export.ready', { url: 'https://x' });
    await received;
    await wait(200);

    expect(deliveredCalls).toEqual([]);
  });

  it('markRead() sends a read frame for the given id', async () => {
    const server = track(await startServer());
    const client = makeClient(server.port);

    const readPromise = new Promise<{ userId: string; id: string }>((resolve) =>
      server.netifly.once('read', (info) => resolve(info))
    );

    client.connect();
    await nextState(client, 'open');
    client.markRead('notif-42');

    const info = await readPromise;
    expect(info.userId).toBe('alice');
    expect(info.id).toBe('notif-42');
  });

  it('respond() sends a response frame with the given payload', async () => {
    const server = track(await startServer());
    const client = makeClient(server.port);

    const responsePromise = new Promise<{ userId: string; id: string; payload: unknown }>((resolve) =>
      server.netifly.once('response', (info) => resolve(info))
    );

    client.connect();
    await nextState(client, 'open');
    client.respond('notif-43', { choice: 'accept' });

    const info = await responsePromise;
    expect(info.userId).toBe('alice');
    expect(info.id).toBe('notif-43');
    expect(info.payload).toEqual({ choice: 'accept' });
  });

  it('markRead() and respond() no-op when not connected', () => {
    const client = createNetiflyClient<Events>({ url: 'ws://127.0.0.1:1/netifly' });
    clients.push(client);
    expect(() => client.markRead('x')).not.toThrow();
    expect(() => client.respond('x', { a: 1 })).not.toThrow();
  });

  it("does not auto-ack the server's own netifly.* relay frames", async () => {
    const server = track(await startServer());
    const clientA = makeClient(server.port);
    const clientB = makeClient(server.port);

    const deliveredCalls: unknown[] = [];
    server.netifly.on('delivered', (info) => deliveredCalls.push(info));

    clientA.connect();
    await nextState(clientA, 'open');
    clientB.connect();
    await nextState(clientB, 'open');

    const relayOnB = new Promise<Envelope>((resolve) => {
      const off = clientB.onAny((envelope) => {
        if (envelope.type === 'netifly.read') {
          off();
          resolve(envelope);
        }
      });
    });

    clientA.markRead('notif-auto-ack-skip');
    const relay = await relayOnB;
    expect(relay.data).toEqual({ id: 'notif-auto-ack-skip' });

    await wait(200);
    expect(deliveredCalls).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/client && npx jest client.test.ts -t "auto-ack|markRead|respond"`
Expected: FAIL — TypeScript errors (`markRead`/`respond`/`autoAck` don't exist yet).

- [ ] **Step 3: Implement**

In `packages/client/src/types.ts`, add to `NetiflyClientOptions`, right after the existing `maxReconnectAttempts?: number;` field (and its doc comment):

```typescript
  /**
   * Auto-sends `{ type: 'ack', id }` back to the server on receipt of every
   * application envelope (never for the server's own `netifly.*` relay
   * frames). Defaults to `true`. Set `false` if your app doesn't want the
   * extra outbound traffic, or wants to ack explicitly on its own schedule.
   */
  autoAck?: boolean;
```

In `packages/client/src/client.ts`:

1. Add the field and read the option in the constructor. Change:

```typescript
  private readonly maxReconnectAttempts: number;
```

to:

```typescript
  private readonly maxReconnectAttempts: number;
  private readonly autoAck: boolean;
```

and change:

```typescript
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
  }
```

to:

```typescript
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
    this.autoAck = options.autoAck ?? true;
  }
```

2. Add `sendFrame`, `markRead`, and `respond` as public/private methods — insert them right after the existing `onError` method and its closing brace, before `private subscribe<T>(...)`:

```typescript
  /** Sends `{ type: 'read', id }`. No-op if not connected. */
  markRead(id: string): void {
    this.sendFrame({ type: 'read', id });
  }

  /** Sends `{ type: 'response', id, payload }`. No-op if not connected. */
  respond(id: string, payload: unknown): void {
    this.sendFrame({ type: 'response', id, payload });
  }

  private sendFrame(
    frame: { type: 'ack' | 'read'; id: string } | { type: 'response'; id: string; payload: unknown }
  ): void {
    if (!this.socket || this.currentState !== 'open') {
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.emitError(toError(error));
    }
  }
```

3. Auto-ack at the end of `handleMessage`. Change:

```typescript
    for (const handler of [...this.anyHandlers]) {
      this.safely(() => handler(envelope));
    }
  }
```

to:

```typescript
    for (const handler of [...this.anyHandlers]) {
      this.safely(() => handler(envelope));
    }

    if (this.autoAck && typeof envelope.id === 'string' && !envelope.type.startsWith('netifly.')) {
      this.sendFrame({ type: 'ack', id: envelope.id });
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/client && npx jest client.test.ts`
Expected: PASS (all tests, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/types.ts packages/client/src/client.ts packages/client/src/client.test.ts
git commit -m "$(cat <<'EOF'
feat(client): add markRead(), respond(), and auto-ack (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Package exports and README

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/README.md`

**Interfaces:**
- Consumes: `AckInfo`, `ResponseInfo`, `SentInfo`, `MalformedFrameInfo`, `MalformedFrameReason` from `./types` (Tasks 3, 6).

- [ ] **Step 1: Add the new type exports**

Change `packages/core/src/index.ts` from:

```typescript
export { createNetifly } from './netiflyServer';
export { createNetiflyPublisher } from './netiflyPublisher';
export { ENVELOPE_VERSION } from './types';
export type {
  AllowedOrigins,
  CloseOptions,
  CreateNetiflyOptions,
  CreateNetiflyPublisherOptions,
  DroppedInfo,
  Envelope,
  EventMap,
  NetiflyInstance,
  NetiflyPublisher,
  RejectInfo,
  ResolveUserId,
  SendOrOptions,
  SendResult,
  UserId,
} from './types';
```

to:

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

- [ ] **Step 2: Verify the exports compile**

Run: `cd packages/core && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Update the README**

In `packages/core/README.md`, add a new row to the options table in the `### createNetifly(options)` section (right after the existing `allowedOrigins` row):

```markdown
| `maxInboundFramesPerSecond` | `number` | — | Max inbound client frames (ack/read/response) accepted per connection, per second. Frames beyond the limit are dropped and counted via `'malformedFrame'` (reason `'rateLimited'`) rather than closing the connection. Defaults to `20`. |
```

Replace the existing single events bullet:

```markdown
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`, `on('reject', ({ reason, status, origin, req }) => void)` — fires when the origin check rejects an upgrade. **Attaching an `'error'` listener is effectively required for production use** — Netifly never throws into the host process (an unhandled `'error'` emit with no listener would crash it), so without a listener attached, Redis/connection failures are completely invisible.
```

with:

```markdown
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`, `on('reject', ({ reason, status, origin, req }) => void)` — fires when the origin check rejects an upgrade. **Attaching an `'error'` listener is effectively required for production use** — Netifly never throws into the host process (an unhandled `'error'` emit with no listener would crash it), so without a listener attached, Redis/connection failures are completely invisible.
- `on('sent', ({ userId, id, type, data }) => void)` — fires synchronously inside `send()`/`sendOr()` (and on `NetiflyPublisher`, too) with the generated envelope id, before the envelope is published. A place to persist a notification record at send time.
- `on('delivered' | 'read', ({ userId, id, ts }) => void)` — fires when a client sends `{ type: 'ack' | 'read', id }` back over its WebSocket connection, exactly once per client action (never once per server instance). Also relayed to the user's other open connections as a `netifly.ack`/`netifly.read` envelope, for multi-tab/multi-device sync.
- `on('response', ({ userId, id, payload, ts }) => void)` — fires when a client sends `{ type: 'response', id, payload }` with an arbitrary JSON payload (e.g. a reply to an action button). Relayed the same way, as `netifly.response`.
- `on('malformedFrame', ({ userId, reason }) => void)` — fires instead of throwing when an inbound client frame is invalid JSON, the wrong shape, or over `maxInboundFramesPerSecond` (`reason`: `'invalidJson' | 'invalidShape' | 'rateLimited'`). The connection is never closed for this.
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts packages/core/README.md
git commit -m "$(cat <<'EOF'
docs(core): export and document delivered/read/response/sent/malformedFrame (NOT-30)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
