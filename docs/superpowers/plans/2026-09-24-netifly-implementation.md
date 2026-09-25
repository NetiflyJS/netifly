# Netifly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish `@netifly/core` and `@netifly/express` — a framework-agnostic, WebSocket + Redis pub/sub notification library for Node.js servers, with full CI and semantic-release automation.

**Architecture:** A pnpm workspace monorepo with two TypeScript packages. `@netifly/core` attaches a `ws` WebSocket server to any `http.Server`, tracks per-instance connections in memory, and coordinates cross-instance delivery through `ioredis` using one Redis pub/sub channel per user (`netifly:user:<id>`), subscribed to only while that instance holds a live connection for that user. `@netifly/express` is a thin convenience wrapper that creates/reuses an Express app's `http.Server` and wires it to `@netifly/core`.

**Tech Stack:** TypeScript, `ws`, `ioredis`, Jest + `ts-jest`, pnpm workspaces, GitHub Actions, `semantic-release` + `semantic-release-monorepo`.

**Spec:** [docs/superpowers/specs/2026-09-24-netifly-design.md](../specs/2026-09-24-netifly-design.md)

## Global Constraints

- Redis credentials are supplied **only** via a single `REDIS_URL` env var; never hardcoded (spec §4.4).
- Delivery is fire-and-forget: no persistence, replay, or acknowledgement (spec §3).
- All source is TypeScript, compiled to JS + `.d.ts` for publishing (spec §7).
- Monorepo uses **pnpm workspaces** (spec §2 decisions).
- Packages publish under the **`@netifly`** npm scope: `@netifly/core`, `@netifly/express` (spec §7).
- License is **MIT** (spec §7).
- Minimum supported Node.js version is **>=18** (resolves spec §12 open item).
- The WebSocket upgrade path defaults to **`/netifly`**, configurable via a `path` option (resolves spec §12 open item).
- `resolveUserId` receives the raw `http.IncomingMessage` from the WS upgrade event, not a framework request object — Express middleware does not run on upgrade requests, since upgrades bypass the HTTP routing layer entirely (resolves spec §12 open item).
- Redis access uses `ioredis` with **two connections per instance** (one dedicated subscriber, one publisher) (spec §4.3).
- Redis routing uses **per-user channels** (`netifly:user:<userId>`), subscribed to only while an instance holds at least one local connection for that user (spec §4.2).

## Review Focus

- A user connected from multiple devices/tabs at once — spec §4.1 requires every connection for that user to receive a `send()`; a single-connection happy-path test would miss a bug that only delivers to one. → covered in Task 5.
- A payload that `JSON.stringify` cannot serialize (circular reference, `BigInt`) — must fail with a clear error, not crash the process or hang a promise. → covered in Task 3.
- `resolveUserId` returning something other than a non-empty string at runtime (a number, an object, `''`) despite the TS type — JS callers aren't type-checked, so this must be rejected exactly like `null`. → covered in Task 5.
- Calling `send()` after `close()` — must reject predictably instead of erroring out of a torn-down Redis connection. → covered in Task 5.
- A client that disappears without a clean WebSocket close frame (crash, network loss) — without a heartbeat this leaks a Redis subscription forever and silently swallows that user's future notifications. → covered in Task 4, wired in Task 5.

---

## Task 1: Monorepo & Tooling Scaffolding

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.eslintrc.cjs`
- Create: `.prettierrc.json`
- Create: `LICENSE`

**Interfaces:**
- Produces: root `pnpm` workspace recognizing `packages/*`; shared `tsconfig.base.json` every package extends; root scripts `build`, `test`, `lint`, `typecheck` that fan out to workspace packages.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "netifly",
  "private": true,
  "license": "MIT",
  "packageManager": "pnpm@9.7.0",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "eslint . --ext .ts --no-error-on-unmatched-pattern",
    "typecheck": "pnpm -r run typecheck"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7.16.0",
    "@typescript-eslint/parser": "^7.16.0",
    "eslint": "^8.57.0",
    "prettier": "^3.3.3",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
coverage/
*.log
.DS_Store
.env
```

- [ ] **Step 5: Create `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
};
```

- [ ] **Step 6: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "printWidth": 100
}
```

- [ ] **Step 7: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 dolufemi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 8: Verify install and lint run cleanly**

Run: `pnpm install && pnpm run lint`
Expected: install succeeds (no packages yet, that's fine); lint reports no errors (no `.ts` files yet, `--no-error-on-unmatched-pattern` prevents a false failure).

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .eslintrc.cjs .prettierrc.json LICENSE pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace, tooling, and license"
```

---

## Task 2: `@netifly/core` Scaffold + ConnectionRegistry

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/jest.config.js`
- Create: `packages/core/src/connectionRegistry.ts`
- Test: `packages/core/src/connectionRegistry.test.ts`

**Interfaces:**
- Produces: `ConnectionRegistry<TConnection>` from `./connectionRegistry`, with `export type UserId = string`. Constructor takes `{ onFirstConnection?: (userId: UserId) => void; onLastDisconnect?: (userId: UserId) => void }`. Methods: `add(userId: UserId, connection: TConnection): void`, `remove(userId: UserId, connection: TConnection): void`, `getConnections(userId: UserId): ReadonlySet<TConnection>`, `hasConnections(userId: UserId): boolean`, `clear(): void`.

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@netifly/core",
  "version": "0.0.0",
  "description": "Framework-agnostic real-time notification core for Node.js servers, backed by WebSockets and Redis.",
  "license": "MIT",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.10",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.2",
    "typescript": "^5.5.4"
  },
  "engines": {
    "node": ">=18"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/core/jest.config.js`**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
};
```

- [ ] **Step 4: Write the failing test**

```ts
// packages/core/src/connectionRegistry.test.ts
import { ConnectionRegistry } from './connectionRegistry';

describe('ConnectionRegistry', () => {
  it('calls onFirstConnection when the first connection for a user is added', () => {
    const onFirstConnection = jest.fn();
    const registry = new ConnectionRegistry<string>({ onFirstConnection });

    registry.add('alice', 'conn-1');

    expect(onFirstConnection).toHaveBeenCalledWith('alice');
    expect(onFirstConnection).toHaveBeenCalledTimes(1);
  });

  it('does not call onFirstConnection again for a second connection from the same user', () => {
    const onFirstConnection = jest.fn();
    const registry = new ConnectionRegistry<string>({ onFirstConnection });

    registry.add('alice', 'conn-1');
    registry.add('alice', 'conn-2');

    expect(onFirstConnection).toHaveBeenCalledTimes(1);
  });

  it('does not call onLastDisconnect when one of two connections is removed', () => {
    const onLastDisconnect = jest.fn();
    const registry = new ConnectionRegistry<string>({ onLastDisconnect });

    registry.add('alice', 'conn-1');
    registry.add('alice', 'conn-2');
    registry.remove('alice', 'conn-1');

    expect(onLastDisconnect).not.toHaveBeenCalled();
    expect(registry.hasConnections('alice')).toBe(true);
  });

  it('calls onLastDisconnect when the last connection for a user is removed', () => {
    const onLastDisconnect = jest.fn();
    const registry = new ConnectionRegistry<string>({ onLastDisconnect });

    registry.add('alice', 'conn-1');
    registry.remove('alice', 'conn-1');

    expect(onLastDisconnect).toHaveBeenCalledWith('alice');
    expect(registry.hasConnections('alice')).toBe(false);
  });

  it('is a safe no-op when removing a connection for an unknown user', () => {
    const registry = new ConnectionRegistry<string>({});

    expect(() => registry.remove('nobody', 'conn-1')).not.toThrow();
  });

  it('returns the exact set of connections for a user', () => {
    const registry = new ConnectionRegistry<string>({});
    registry.add('bob', 'conn-1');
    registry.add('bob', 'conn-2');

    expect(registry.getConnections('bob')).toEqual(new Set(['conn-1', 'conn-2']));
    expect(registry.getConnections('unknown')).toEqual(new Set());
  });

  it('clear() removes all tracked connections', () => {
    const registry = new ConnectionRegistry<string>({});
    registry.add('bob', 'conn-1');

    registry.clear();

    expect(registry.hasConnections('bob')).toBe(false);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @netifly/core test`
Expected: FAIL — `Cannot find module './connectionRegistry'`

- [ ] **Step 6: Write minimal implementation**

```ts
// packages/core/src/connectionRegistry.ts
export type UserId = string;

export interface ConnectionRegistryOptions {
  onFirstConnection?: (userId: UserId) => void;
  onLastDisconnect?: (userId: UserId) => void;
}

export class ConnectionRegistry<TConnection> {
  private readonly connections = new Map<UserId, Set<TConnection>>();
  private readonly onFirstConnection: (userId: UserId) => void;
  private readonly onLastDisconnect: (userId: UserId) => void;

  constructor(options: ConnectionRegistryOptions) {
    this.onFirstConnection = options.onFirstConnection ?? (() => {});
    this.onLastDisconnect = options.onLastDisconnect ?? (() => {});
  }

  add(userId: UserId, connection: TConnection): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(connection);
    if (wasEmpty) {
      this.onFirstConnection(userId);
    }
  }

  remove(userId: UserId, connection: TConnection): void {
    const set = this.connections.get(userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(userId);
      this.onLastDisconnect(userId);
    }
  }

  getConnections(userId: UserId): ReadonlySet<TConnection> {
    return this.connections.get(userId) ?? new Set<TConnection>();
  }

  hasConnections(userId: UserId): boolean {
    return this.connections.has(userId);
  }

  clear(): void {
    this.connections.clear();
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @netifly/core test`
Expected: PASS (7 tests)

- [ ] **Step 8: Commit**

```bash
git add packages/core/package.json packages/core/tsconfig.json packages/core/jest.config.js packages/core/src/connectionRegistry.ts packages/core/src/connectionRegistry.test.ts pnpm-lock.yaml
git commit -m "feat(core): add connection registry with refcounted lifecycle hooks"
```

---

## Task 3: `@netifly/core` RedisRouter

**Requires:** a local Redis reachable at `redis://127.0.0.1:6379` while running this task's tests (e.g. `docker run --rm -p 6379:6379 redis:7-alpine`).

**Files:**
- Modify: `packages/core/package.json` (add `ioredis` dependency)
- Create: `packages/core/src/redisRouter.ts`
- Test: `packages/core/src/redisRouter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RedisRouter` from `./redisRouter`. Constructor: `{ redisUrl: string; onMessage: (userId: UserId, rawMessage: string) => void; onError?: (error: Error) => void }`. Methods: `subscribe(userId: UserId): Promise<void>`, `unsubscribe(userId: UserId): Promise<void>`, `publish(userId: UserId, payload: unknown): Promise<void>` (rejects with a clear `Error` if `payload` is not JSON-serializable), `close(): Promise<void>`. Also exports `channelName(userId: UserId): string`.

- [ ] **Step 1: Add `ioredis` to `packages/core/package.json`**

```json
{
  "name": "@netifly/core",
  "version": "0.0.0",
  "description": "Framework-agnostic real-time notification core for Node.js servers, backed by WebSockets and Redis.",
  "license": "MIT",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "ioredis": "^5.4.1"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.10",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.2",
    "typescript": "^5.5.4"
  },
  "engines": {
    "node": ">=18"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/redisRouter.test.ts
import { RedisRouter, channelName } from './redisRouter';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

describe('channelName', () => {
  it('formats the per-user channel name', () => {
    expect(channelName('alice')).toBe('netifly:user:alice');
  });
});

describe('RedisRouter', () => {
  let routers: RedisRouter[];

  beforeEach(() => {
    routers = [];
  });

  afterEach(async () => {
    await Promise.all(routers.map((router) => router.close()));
  });

  function createRouter(onMessage: (userId: string, rawMessage: string) => void): RedisRouter {
    const router = new RedisRouter({ redisUrl: REDIS_URL, onMessage });
    routers.push(router);
    return router;
  }

  it('delivers a published message to a subscribed router', async () => {
    const received: Array<{ userId: string; rawMessage: string }> = [];
    let resolveReceived: () => void;
    const receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    const subscriberRouter = createRouter((userId, rawMessage) => {
      received.push({ userId, rawMessage });
      resolveReceived();
    });
    const publisherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('alice');
    await publisherRouter.publish('alice', { hello: 'world' });
    await receivedPromise;

    expect(received).toEqual([{ userId: 'alice', rawMessage: JSON.stringify({ hello: 'world' }) }]);
  });

  it('does not deliver to a userId nobody has subscribed to', async () => {
    const onMessage = jest.fn();
    const publisherRouter = createRouter(onMessage);

    await publisherRouter.publish('nobody-home', { hello: 'world' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    const onMessage = jest.fn();
    const subscriberRouter = createRouter(onMessage);
    const publisherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('bob');
    await subscriberRouter.unsubscribe('bob');
    await publisherRouter.publish('bob', { hello: 'world' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('rejects a non-serializable payload with a clear error', async () => {
    const publisherRouter = createRouter(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(publisherRouter.publish('zoe', circular)).rejects.toThrow(
      'Netifly: payload for user "zoe" is not JSON-serializable'
    );
  });

  it('surfaces connection errors via onError instead of throwing', async () => {
    const onError = jest.fn();
    const router = new RedisRouter({
      redisUrl: 'redis://127.0.0.1:1',
      onMessage: () => {},
      onError,
    });
    routers.push(router);

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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @netifly/core test`
Expected: FAIL — `Cannot find module './redisRouter'`

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/core/src/redisRouter.ts
import Redis from 'ioredis';
import type { UserId } from './connectionRegistry';

export interface RedisRouterOptions {
  redisUrl: string;
  onMessage: (userId: UserId, rawMessage: string) => void;
  onError?: (error: Error) => void;
}

const CHANNEL_PREFIX = 'netifly:user:';

export function channelName(userId: UserId): string {
  return `${CHANNEL_PREFIX}${userId}`;
}

function userIdFromChannel(channel: string): UserId | null {
  return channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;
}

export class RedisRouter {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(options: RedisRouterOptions) {
    this.publisher = new Redis(options.redisUrl);
    this.subscriber = new Redis(options.redisUrl);

    if (options.onError) {
      this.publisher.on('error', options.onError);
      this.subscriber.on('error', options.onError);
    }

    this.subscriber.on('message', (channel, rawMessage) => {
      const userId = userIdFromChannel(channel);
      if (userId !== null) {
        options.onMessage(userId, rawMessage);
      }
    });
  }

  async subscribe(userId: UserId): Promise<void> {
    await this.subscriber.subscribe(channelName(userId));
  }

  async unsubscribe(userId: UserId): Promise<void> {
    await this.subscriber.unsubscribe(channelName(userId));
  }

  async publish(userId: UserId, payload: unknown): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      throw new Error(`Netifly: payload for user "${userId}" is not JSON-serializable`, {
        cause: error,
      });
    }
    await this.publisher.publish(channelName(userId), serialized);
  }

  async close(): Promise<void> {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @netifly/core test`
Expected: PASS (6 tests). Requires local Redis on `127.0.0.1:6379`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/redisRouter.ts packages/core/src/redisRouter.test.ts pnpm-lock.yaml
git commit -m "feat(core): add Redis pub/sub router with per-user channels"
```

---

## Task 4: `@netifly/core` Heartbeat Helper

**Files:**
- Modify: `packages/core/package.json` (add `ws` dependency + `@types/ws` dev dependency)
- Create: `packages/core/src/heartbeat.ts`
- Test: `packages/core/src/heartbeat.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `startHeartbeat(options: { intervalMs: number; getClients: () => Iterable<WebSocket> }): NodeJS.Timeout` from `./heartbeat`, using the `WebSocket` type from `ws`.

- [ ] **Step 1: Add `ws` to `packages/core/package.json`**

```json
{
  "name": "@netifly/core",
  "version": "0.0.0",
  "description": "Framework-agnostic real-time notification core for Node.js servers, backed by WebSockets and Redis.",
  "license": "MIT",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "ioredis": "^5.4.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.10",
    "@types/ws": "^8.5.10",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.2",
    "typescript": "^5.5.4"
  },
  "engines": {
    "node": ">=18"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/heartbeat.test.ts
import type { WebSocket } from 'ws';
import { startHeartbeat } from './heartbeat';

function createMockSocket() {
  const handlers: Record<string, () => void> = {};
  return {
    ping: jest.fn(),
    terminate: jest.fn(),
    once: jest.fn((event: string, cb: () => void) => {
      handlers[event] = cb;
    }),
    emitPong: () => handlers.pong?.(),
  };
}

describe('startHeartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pings every client on each interval tick', () => {
    const client = createMockSocket();
    startHeartbeat({ intervalMs: 1000, getClients: () => [client as unknown as WebSocket] });

    jest.advanceTimersByTime(1000);

    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it('terminates a client that never responded to the previous ping', () => {
    const client = createMockSocket();
    startHeartbeat({ intervalMs: 1000, getClients: () => [client as unknown as WebSocket] });

    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(1000);

    expect(client.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps a client alive if it responds with pong before the next tick', () => {
    const client = createMockSocket();
    startHeartbeat({ intervalMs: 1000, getClients: () => [client as unknown as WebSocket] });

    jest.advanceTimersByTime(1000);
    client.emitPong();
    jest.advanceTimersByTime(1000);

    expect(client.terminate).not.toHaveBeenCalled();
    expect(client.ping).toHaveBeenCalledTimes(2);
  });

  it('stops ticking after the returned timer is cleared', () => {
    const client = createMockSocket();
    const timer = startHeartbeat({
      intervalMs: 1000,
      getClients: () => [client as unknown as WebSocket],
    });
    clearInterval(timer);

    jest.advanceTimersByTime(5000);

    expect(client.ping).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @netifly/core test`
Expected: FAIL — `Cannot find module './heartbeat'`

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/core/src/heartbeat.ts
import type { WebSocket } from 'ws';

export interface HeartbeatOptions {
  intervalMs: number;
  getClients: () => Iterable<WebSocket>;
}

// A client that doesn't answer one ping with a pong before the next tick is
// assumed dead (crashed, lost network) and terminated so its Redis
// subscription doesn't leak forever.
export function startHeartbeat(options: HeartbeatOptions): NodeJS.Timeout {
  const alive = new WeakMap<WebSocket, boolean>();

  return setInterval(() => {
    for (const ws of options.getClients()) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.once('pong', () => alive.set(ws, true));
      ws.ping();
    }
  }, options.intervalMs);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @netifly/core test`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/heartbeat.ts packages/core/src/heartbeat.test.ts pnpm-lock.yaml
git commit -m "feat(core): add ping/pong heartbeat to reap dead connections"
```

---

## Task 5: `@netifly/core` `createNetifly` (NetiflyServer Integration)

**Requires:** local Redis on `redis://127.0.0.1:6379`.

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/netiflyServer.ts`
- Test: `packages/core/src/netiflyServer.test.ts`

**Interfaces:**
- Consumes: `ConnectionRegistry` (Task 2), `RedisRouter`/`channelName` (Task 3), `startHeartbeat` (Task 4).
- Produces: `createNetifly(options: CreateNetiflyOptions): NetiflyInstance` from `./netiflyServer`; types `UserId`, `ResolveUserId`, `CreateNetiflyOptions`, `NetiflyInstance` from `./types`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/netiflyServer.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createNetifly } from './netiflyServer';
import type { NetiflyInstance } from './types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

interface TestServer {
  netifly: NetiflyInstance;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  resolveUserId: (req: http.IncomingMessage) => unknown
): Promise<TestServer> {
  const httpServer = http.createServer((_req, res) => res.end());
  const netifly = createNetifly({
    server: httpServer,
    resolveUserId: resolveUserId as never,
    redisUrl: REDIS_URL,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    netifly,
    port,
    close: async () => {
      await netifly.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/netifly`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createNetifly', () => {
  const servers: TestServer[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(
      clients.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once('close', () => resolve());
            ws.close();
          })
      )
    );
    clients.length = 0;
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it('rejects the upgrade when resolveUserId returns null', async () => {
    const server = await startTestServer(() => null);
    servers.push(server);

    await expect(connectClient(server.port)).rejects.toBeDefined();
  });

  it('rejects the upgrade when resolveUserId returns a non-string value', async () => {
    const server = await startTestServer(() => 12345);
    servers.push(server);

    await expect(connectClient(server.port)).rejects.toBeDefined();
  });

  it('delivers a send() to a connection on the same instance', async () => {
    const server = await startTestServer(() => 'alice');
    servers.push(server);

    const client = await connectClient(server.port);
    clients.push(client);
    await wait(100); // allow the initial Redis SUBSCRIBE to be acknowledged

    const messagePromise = nextMessage(client);
    await server.netifly.send('alice', { type: 'greeting', text: 'hi' });

    await expect(messagePromise).resolves.toBe(JSON.stringify({ type: 'greeting', text: 'hi' }));
  });

  it('delivers a send() across two server instances via Redis', async () => {
    const serverA = await startTestServer(() => 'bob');
    const serverB = await startTestServer(() => 'bob');
    servers.push(serverA, serverB);

    const client = await connectClient(serverB.port);
    clients.push(client);
    await wait(100);

    const messagePromise = nextMessage(client);
    await serverA.netifly.send('bob', { type: 'cross-instance' });

    await expect(messagePromise).resolves.toBe(JSON.stringify({ type: 'cross-instance' }));
  });

  it('delivers a send() to every connection a user has open', async () => {
    const server = await startTestServer(() => 'frank');
    servers.push(server);

    const clientA = await connectClient(server.port);
    const clientB = await connectClient(server.port);
    clients.push(clientA, clientB);
    await wait(100);

    const messageA = nextMessage(clientA);
    const messageB = nextMessage(clientB);
    await server.netifly.send('frank', { type: 'multi-tab' });

    await expect(messageA).resolves.toBe(JSON.stringify({ type: 'multi-tab' }));
    await expect(messageB).resolves.toBe(JSON.stringify({ type: 'multi-tab' }));
  });

  it('is a no-op when sending to a user with no connections anywhere', async () => {
    const server = await startTestServer(() => 'carol');
    servers.push(server);

    await expect(server.netifly.send('nobody-online', { type: 'x' })).resolves.toBeUndefined();
  });

  it("disconnect() closes all of a user's local connections", async () => {
    const server = await startTestServer(() => 'dave');
    servers.push(server);

    const client = await connectClient(server.port);
    clients.push(client);
    await wait(100);

    const closePromise = new Promise<void>((resolve) => client.once('close', () => resolve()));
    server.netifly.disconnect('dave');

    await closePromise;
  });

  it('rejects send() after close()', async () => {
    const server = await startTestServer(() => 'gina');
    servers.push(server);

    await server.netifly.close();
    await expect(server.netifly.send('gina', { type: 'x' })).rejects.toThrow(
      'Netifly: cannot send after close()'
    );

    servers.pop(); // already closed above; skip afterEach double-close
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @netifly/core test`
Expected: FAIL — `Cannot find module './netiflyServer'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/types.ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';

export type UserId = string;

export type ResolveUserId = (
  req: IncomingMessage
) => UserId | null | undefined | Promise<UserId | null | undefined>;

export interface CreateNetiflyOptions {
  server: HttpServer;
  resolveUserId: ResolveUserId;
  redisUrl?: string;
  path?: string;
}

export interface NetiflyInstance {
  send(userId: UserId, payload: unknown): Promise<void>;
  disconnect(userId: UserId): void;
  on(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  close(): Promise<void>;
}
```

```ts
// packages/core/src/netiflyServer.ts
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { ConnectionRegistry } from './connectionRegistry';
import { RedisRouter } from './redisRouter';
import { startHeartbeat } from './heartbeat';
import type { CreateNetiflyOptions, NetiflyInstance, UserId } from './types';

const DEFAULT_PATH = '/netifly';
const HEARTBEAT_INTERVAL_MS = 30_000;

class NetiflyServerImpl extends EventEmitter implements NetiflyInstance {
  private readonly wss: WebSocketServer;
  private readonly registry: ConnectionRegistry<WebSocket>;
  private readonly router: RedisRouter;
  private readonly resolveUserId: CreateNetiflyOptions['resolveUserId'];
  private readonly path: string;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private closed = false;

  constructor(options: CreateNetiflyOptions) {
    super();
    this.resolveUserId = options.resolveUserId;
    this.path = options.path ?? DEFAULT_PATH;

    this.registry = new ConnectionRegistry<WebSocket>({
      onLastDisconnect: (userId) => {
        void this.router.unsubscribe(userId);
      },
    });

    this.router = new RedisRouter({
      redisUrl: options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      onMessage: (userId, rawMessage) => this.deliverLocally(userId, rawMessage),
      onError: (error) => this.emit('error', error),
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.heartbeatTimer = startHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      getClients: () => this.wss.clients,
    });

    options.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== this.path) {
      return;
    }

    let userId: unknown;
    try {
      userId = await this.resolveUserId(req);
    } catch {
      userId = null;
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      socket.destroy();
      return;
    }

    const resolvedUserId = userId;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.registerConnection(resolvedUserId, ws);
    });
  }

  // Awaiting the Redis SUBSCRIBE before registering the connection (rather
  // than firing it in the background) minimizes the window where a send()
  // that races a brand-new connection would be dropped.
  private async registerConnection(userId: UserId, ws: WebSocket): Promise<void> {
    if (!this.registry.hasConnections(userId)) {
      await this.router.subscribe(userId);
    }
    this.registry.add(userId, ws);
    this.emit('connect', userId);

    ws.on('close', () => {
      this.registry.remove(userId, ws);
      this.emit('disconnect', userId);
    });
  }

  private deliverLocally(userId: UserId, rawMessage: string): void {
    for (const ws of this.registry.getConnections(userId)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(rawMessage);
      }
    }
  }

  async send(userId: UserId, payload: unknown): Promise<void> {
    if (this.closed) {
      throw new Error('Netifly: cannot send after close()');
    }
    await this.router.publish(userId, payload);
  }

  disconnect(userId: UserId): void {
    for (const ws of this.registry.getConnections(userId)) {
      ws.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
    await this.router.close();
    this.registry.clear();
  }
}

export function createNetifly(options: CreateNetiflyOptions): NetiflyInstance {
  return new NetiflyServerImpl(options);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @netifly/core test`
Expected: PASS (8 tests). Requires local Redis on `127.0.0.1:6379`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/netiflyServer.ts packages/core/src/netiflyServer.test.ts
git commit -m "feat(core): add createNetifly integrating WS, Redis routing, and heartbeat"
```

---

## Task 6: `@netifly/core` Public Exports + Build

**Files:**
- Create: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `createNetifly` and types from Task 5.
- Produces: the package's public entry point (`dist/index.js` + `dist/index.d.ts` after build) — this is what `@netifly/express` and end users import as `@netifly/core`.

- [ ] **Step 1: Create the barrel export**

```ts
// packages/core/src/index.ts
export { createNetifly } from './netiflyServer';
export type {
  CreateNetiflyOptions,
  NetiflyInstance,
  ResolveUserId,
  UserId,
} from './types';
```

- [ ] **Step 2: Build and verify the output**

Run: `pnpm --filter @netifly/core build && node -e "console.log(typeof require('./packages/core/dist/index.js').createNetifly)"`
Expected: prints `function`; `packages/core/dist/index.js` and `packages/core/dist/index.d.ts` both exist.

- [ ] **Step 3: Run the full test + typecheck suite for the package**

Run: `pnpm --filter @netifly/core typecheck && pnpm --filter @netifly/core test`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add public entry point"
```

---

## Task 7: `@netifly/express` Adapter

**Requires:** local Redis on `redis://127.0.0.1:6379`.

**Files:**
- Create: `packages/express/package.json`
- Create: `packages/express/tsconfig.json`
- Create: `packages/express/jest.config.js`
- Create: `packages/express/src/index.ts`
- Test: `packages/express/src/index.test.ts`

**Interfaces:**
- Consumes: `createNetifly`, `CreateNetiflyOptions`, `NetiflyInstance` from `@netifly/core` (Task 6, as a workspace dependency).
- Produces: `attachNetifly(app: Express, options: AttachNetiflyOptions): { server: http.Server; netifly: NetiflyInstance }` from `./index`.

- [ ] **Step 1: Create `packages/express/package.json`**

```json
{
  "name": "@netifly/express",
  "version": "0.0.0",
  "description": "Express adapter for @netifly/core — real-time per-user WebSocket notifications backed by Redis.",
  "license": "MIT",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@netifly/core": "workspace:*"
  },
  "peerDependencies": {
    "express": "^4.19.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.10",
    "express": "^4.19.2",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.2",
    "typescript": "^5.5.4"
  },
  "engines": {
    "node": ">=18"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `packages/express/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/express/jest.config.js`**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
};
```

- [ ] **Step 4: Install and build the workspace dependency**

Run: `pnpm install && pnpm --filter @netifly/core build`

- [ ] **Step 5: Write the failing test**

```ts
// packages/express/src/index.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import { attachNetifly } from './index';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

describe('attachNetifly', () => {
  it('creates an http.Server from the Express app and wires netifly to it', async () => {
    const app = express();
    app.get('/health', (_req, res) => res.send('ok'));

    const { server, netifly } = attachNetifly(app, {
      resolveUserId: () => 'eve',
      redisUrl: REDIS_URL,
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const httpResponse = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await httpResponse.text()).toBe('ok');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/netifly`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const messagePromise = new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
    });
    await netifly.send('eve', { hello: 'express' });
    await expect(messagePromise).resolves.toBe(JSON.stringify({ hello: 'express' }));

    ws.close();
    await netifly.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reuses a server passed explicitly instead of creating a new one', async () => {
    const app = express();
    const existingServer = http.createServer(app);

    const { server, netifly } = attachNetifly(app, {
      resolveUserId: () => null,
      redisUrl: REDIS_URL,
      server: existingServer,
    });

    expect(server).toBe(existingServer);
    await netifly.close();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @netifly/express test`
Expected: FAIL — `Cannot find module './index'`

- [ ] **Step 7: Write minimal implementation**

```ts
// packages/express/src/index.ts
import http from 'node:http';
import type { Express } from 'express';
import { createNetifly } from '@netifly/core';
import type { CreateNetiflyOptions, NetiflyInstance } from '@netifly/core';

export interface AttachNetiflyOptions extends Omit<CreateNetiflyOptions, 'server'> {
  server?: http.Server;
}

export interface AttachNetiflyResult {
  server: http.Server;
  netifly: NetiflyInstance;
}

export function attachNetifly(app: Express, options: AttachNetiflyOptions): AttachNetiflyResult {
  const server = options.server ?? http.createServer(app);
  const netifly = createNetifly({ ...options, server });
  return { server, netifly };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @netifly/express test`
Expected: PASS (2 tests). Requires local Redis on `127.0.0.1:6379`.

- [ ] **Step 9: Commit**

```bash
git add packages/express/package.json packages/express/tsconfig.json packages/express/jest.config.js packages/express/src/index.ts packages/express/src/index.test.ts pnpm-lock.yaml
git commit -m "feat(express): add attachNetifly adapter"
```

---

## Task 8: `@netifly/express` Build Verification

**Files:**
- Modify: none (verification-only task)

**Interfaces:**
- Consumes: `attachNetifly` from Task 7.
- Produces: `dist/index.js` + `dist/index.d.ts` for `@netifly/express`.

- [ ] **Step 1: Build and verify the output**

Run: `pnpm --filter @netifly/express build && node -e "console.log(typeof require('./packages/express/dist/index.js').attachNetifly)"`
Expected: prints `function`; `packages/express/dist/index.js` and `packages/express/dist/index.d.ts` both exist.

- [ ] **Step 2: Run the full workspace test + typecheck + build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS across both packages.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: verify @netifly/express build output" --allow-empty
```

---

## Task 9: CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root `lint`/`typecheck`/`test`/`build` scripts (Task 1), both packages' test suites (Tasks 2–8).
- Produces: a GitHub Actions workflow that runs on every PR and push to `main`.

- [ ] **Step 1: Create the workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    strategy:
      matrix:
        node-version: [18, 20]
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run test
        env:
          REDIS_URL: redis://127.0.0.1:6379
      - run: pnpm run build
```

- [ ] **Step 2: Verify locally**

Run: `pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && REDIS_URL=redis://127.0.0.1:6379 pnpm run test && pnpm run build`
Expected: every command exits 0, mirroring what the workflow will run. (The workflow file itself is only truly validated by GitHub on the first push — there is no local Actions runner in this project.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint/typecheck/test/build workflow with a Redis service container"
```

---

## Task 10: Release Automation (semantic-release)

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `packages/core/.releaserc.json`
- Create: `packages/express/.releaserc.json`
- Create: `.npmrc`
- Modify: `package.json` (add semantic-release tooling as root devDependencies)

**Interfaces:**
- Consumes: the build/test pipeline from Task 9; publishes `@netifly/core` and `@netifly/express` (Tasks 6 and 8) to npm.
- Produces: independent semantic-versioned releases per package, triggered on push to `main`, gated by `NPM_TOKEN` and `GITHUB_TOKEN` repo secrets the maintainer creates.

- [ ] **Step 1: Add semantic-release tooling to root `package.json`**

```json
{
  "name": "netifly",
  "private": true,
  "license": "MIT",
  "packageManager": "pnpm@9.7.0",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "eslint . --ext .ts --no-error-on-unmatched-pattern",
    "typecheck": "pnpm -r run typecheck"
  },
  "devDependencies": {
    "@semantic-release/changelog": "^6.0.3",
    "@semantic-release/commit-analyzer": "^13.0.0",
    "@semantic-release/git": "^10.0.1",
    "@semantic-release/github": "^10.1.1",
    "@semantic-release/npm": "^12.0.1",
    "@semantic-release/release-notes-generator": "^14.0.1",
    "@typescript-eslint/eslint-plugin": "^7.16.0",
    "@typescript-eslint/parser": "^7.16.0",
    "eslint": "^8.57.0",
    "prettier": "^3.3.3",
    "semantic-release": "^24.0.0",
    "semantic-release-monorepo": "^8.0.2",
    "typescript": "^5.5.4"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: Create `packages/core/.releaserc.json`**

```json
{
  "extends": "semantic-release-monorepo",
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    [
      "@semantic-release/git",
      {
        "assets": ["package.json", "CHANGELOG.md"],
        "message": "chore(release): @netifly/core ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ],
    "@semantic-release/github"
  ]
}
```

- [ ] **Step 3: Create `packages/express/.releaserc.json`**

```json
{
  "extends": "semantic-release-monorepo",
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    [
      "@semantic-release/git",
      {
        "assets": ["package.json", "CHANGELOG.md"],
        "message": "chore(release): @netifly/express ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ],
    "@semantic-release/github"
  ]
}
```

- [ ] **Step 4: Create `.npmrc`**

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

- [ ] **Step 5: Create the release workflow**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm run build

      - name: Release @netifly/core
        working-directory: packages/core
        run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Release @netifly/express
        working-directory: packages/express
        run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 6: Verify config syntax locally**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/core/.releaserc.json','utf8')); JSON.parse(require('fs').readFileSync('packages/express/.releaserc.json','utf8')); console.log('valid json')"`
Expected: prints `valid json`. (Actually running `semantic-release` requires a real `NPM_TOKEN`/`GITHUB_TOKEN` and repo history, so the real validation happens on the first push to `main` once you've created those two repo secrets and the `@netifly` npm org — see the README's publishing section.)

- [ ] **Step 7: Commit**

```bash
git add package.json .github/workflows/release.yml packages/core/.releaserc.json packages/express/.releaserc.json .npmrc pnpm-lock.yaml
git commit -m "ci: add per-package semantic-release automation"
```

---

## Task 11: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the finished public API of both packages (Tasks 6, 7) and the CI/release workflows (Tasks 9, 10) for badge URLs.
- Produces: the repo's landing documentation.

- [ ] **Step 1: Create `README.md`**

```markdown
# 🔔 Netifly

Framework-agnostic, real-time per-user notifications for Node.js servers — WebSockets in, Redis pub/sub for horizontal scaling.

[![npm version](https://img.shields.io/npm/v/@netifly/core.svg)](https://www.npmjs.com/package/@netifly/core)
[![CI](https://github.com/dolufemi/netifly/actions/workflows/ci.yml/badge.svg)](https://github.com/dolufemi/netifly/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@netifly/core.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@netifly/core.svg)](https://www.npmjs.com/package/@netifly/core)

## ✨ Features

- 🔌 **Framework-agnostic core** — attaches to any Node `http.Server`, so it works under Express, Fastify, Koa, NestJS, or raw `http`.
- ⚡ **Express adapter** (`@netifly/express`) for a one-line setup.
- 🔁 **Horizontally scalable** — any number of server instances stay in sync through Redis pub/sub, no sticky sessions required.
- 🔐 **Auth-agnostic** — you supply a `resolveUserId` function; Netifly doesn't care how you authenticate.
- 💓 **Dead-connection reaping** — a ping/pong heartbeat terminates clients that silently disappeared.
- 🧩 **Zero opinions on payload shape** — send whatever JSON-serializable data your app needs.

## 📦 Installation

```bash
npm install @netifly/core
# or, for Express apps:
npm install @netifly/core @netifly/express
```

## 🚀 Quickstart

### Plain Node `http`

```ts
import http from 'node:http';
import { createNetifly } from '@netifly/core';

const server = http.createServer((req, res) => res.end('ok'));

const netifly = createNetifly({
  server,
  resolveUserId: async (req) => verifyJwtFromRequest(req), // your own auth
});

server.listen(3000);

// Anywhere in your app:
netifly.send(userId, { type: 'comment.created', payload: { commentId: 42 } });
```

### Express

```ts
import express from 'express';
import { attachNetifly } from '@netifly/express';

const app = express();

const { server, netifly } = attachNetifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

app.post('/comments', (req, res) => {
  const comment = createComment(req.body);
  netifly.send(comment.authorId, { type: 'comment.created', payload: comment });
  res.status(201).json(comment);
});

server.listen(3000);
```

> ⚠️ WebSocket upgrade requests bypass Express's routing/middleware entirely, so `resolveUserId` always receives the raw Node `IncomingMessage`, not an Express `Request`.

## 🔐 Redis Configuration

Netifly reads a single `REDIS_URL` environment variable — never hardcode credentials:

```bash
REDIS_URL=redis://:password@host:6379/0
# or with TLS:
REDIS_URL=rediss://user:password@host:6380/0
```

You can also pass `redisUrl` explicitly to `createNetifly()`/`attachNetifly()`, which takes priority over the env var.

## 📖 API Reference

### `createNetifly(options)` — `@netifly/core`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `server` | `http.Server` | ✅ | The server to attach the WebSocket upgrade handler to. |
| `resolveUserId` | `(req) => string \| null \| undefined \| Promise<...>` | ✅ | Identifies the connecting user. Returning a falsy value rejects the connection. |
| `redisUrl` | `string` | — | Defaults to `process.env.REDIS_URL`. |
| `path` | `string` | — | WebSocket upgrade path. Defaults to `/netifly`. |

Returns a `NetiflyInstance`:

- `send(userId, payload): Promise<void>` — delivers `payload` to every connection that user has open, anywhere in your cluster. No-op if the user isn't connected anywhere.
- `disconnect(userId): void` — force-closes all of a user's local connections (e.g. on logout).
- `on('connect' | 'disconnect', (userId) => void)`, `on('error', (error) => void)`.
- `close(): Promise<void>` — graceful shutdown: stops the heartbeat, closes the WS server, and closes both Redis connections.

### `attachNetifly(app, options)` — `@netifly/express`

Same `options` as `createNetifly`, minus `server` (optional — pass your own, or let it create one from the Express app). Returns `{ server, netifly }`.

## 🏗️ Architecture

```
Client A ──WS──► Server Instance 1 ──┐
Client B ──WS──► Server Instance 2 ──┼──► Redis (pub/sub, per-user channels)
Client C ──WS──► Server Instance 3 ──┘
```

Each instance subscribes to a user's Redis channel (`netifly:user:<id>`) only while it holds a live connection for that user, and unsubscribes the moment that user disconnects locally — so `send()` traffic only reaches the instance(s) that actually need it.

## 🧪 Testing & Development

This is a pnpm workspace monorepo.

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
pnpm test
pnpm build
```

## 🤝 Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) — `semantic-release` uses them to decide each package's next version and changelog automatically on merge to `main`.

## 📄 License

[MIT](./LICENSE)
```

- [ ] **Step 2: Sanity-check the badges point at the right package/repo names**

Confirm `@netifly/core` and `dolufemi/netifly` match the actual npm scope and GitHub repo you create.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add GitHub-friendly README with badges and quickstart"
```

---

## Post-Plan Manual Setup (not part of any task — for the maintainer)

These are one-time account/infra steps outside this codebase, per the earlier design decision that you'll handle npm/GitHub account setup yourself:

1. Create a GitHub repo (e.g. `dolufemi/netifly`) and push this branch to it.
2. Create the `@netifly` npm organization/scope on npmjs.com.
3. Generate an npm **automation token** with publish rights to `@netifly`, and add it to the GitHub repo as a secret named `NPM_TOKEN`.
4. Confirm Actions has permission to create releases (Settings → Actions → General → Workflow permissions → "Read and write permissions") so `@semantic-release/github` and `@semantic-release/git` can push tags/changelog commits using the built-in `GITHUB_TOKEN`.
