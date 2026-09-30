import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type Redis from 'ioredis';
import { createNetifly } from './netiflyServer';
import { createNetiflyPublisher } from './netiflyPublisher';
import { NotificationValidationError } from './notification';
import type { CreateNetiflyOptions, NetiflyInstance, NetiflyPublisher } from './types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

interface TestServer {
  netifly: NetiflyInstance;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  resolveUserId: (req: http.IncomingMessage) => unknown,
  extra: Partial<CreateNetiflyOptions> = {}
): Promise<TestServer> {
  const httpServer = http.createServer((_req, res) => res.end());
  const netifly = createNetifly({
    server: httpServer,
    resolveUserId: resolveUserId as never,
    redisUrl: REDIS_URL,
    actionSecret: false,
    ...extra,
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

function connectClient(port: number, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/netifly`, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

function onceEvent(emitter: NetiflyInstance, event: 'connect'): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

describe('createNetiflyPublisher', () => {
  const servers: TestServer[] = [];
  const clients: WebSocket[] = [];
  const publishers: NetiflyPublisher[] = [];

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
    await Promise.all(publishers.map((publisher) => publisher.close()));
    publishers.length = 0;
  });

  it('throws at construction time when neither redisUrl nor REDIS_URL is set', () => {
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      expect(() => createNetiflyPublisher({})).toThrow(
        'Netifly: no redisUrl provided and REDIS_URL is not set'
      );
    } finally {
      if (original !== undefined) process.env.REDIS_URL = original;
    }
  });

  it('acceptance criterion: publisher.send() delivers to a socket held by a separate createNetifly() server (NOT-15)', async () => {
    const userId = 'netiflyPublisher-cross-process';
    const server = await startTestServer(() => userId);
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    const messagePromise = nextMessage(client);
    const result = await publisher.send(userId, 'export.ready', { url: 'https://example.com/x' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope).toMatchObject({
      v: 1,
      type: 'export.ready',
      data: { url: 'https://example.com/x' },
    });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.ts).toBe('number');
    expect(result).toEqual({ delivered: true, instances: 1 });
  });

  it('wraps a two-arg send() payload in an envelope with type "message"', async () => {
    const userId = 'netiflyPublisher-two-arg';
    const server = await startTestServer(() => userId);
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    const messagePromise = nextMessage(client);
    await publisher.send(userId, { text: 'hi' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope).toMatchObject({ v: 1, type: 'message', data: { text: 'hi' } });
  });

  it('respects namespace so publisher and server agree on the channel (NOT-18)', async () => {
    const userId = 'netiflyPublisher-namespaced';
    const server = await startTestServer(() => userId, { namespace: 'staging' });
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL, namespace: 'staging' });
    publishers.push(publisher);

    const messagePromise = nextMessage(client);
    const result = await publisher.send(userId, 'ns.check', { ok: true });
    await messagePromise;

    expect(result).toEqual({ delivered: true, instances: 1 });

    // A publisher without the matching namespace must not reach the same user.
    const unnamespacedPublisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(unnamespacedPublisher);
    await expect(unnamespacedPublisher.send(userId, 'ns.miss', { ok: false })).resolves.toEqual({
      delivered: false,
      instances: 0,
    });
  });

  it('isOnline() reflects a connection held by a separate createNetifly() server', async () => {
    const onlineUserId = 'netiflyPublisher-online';
    const offlineUserId = 'netiflyPublisher-offline';
    const server = await startTestServer(() => onlineUserId);
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    await expect(publisher.isOnline(onlineUserId)).resolves.toBe(true);
    await expect(publisher.isOnline(offlineUserId)).resolves.toBe(false);
  });

  it('whoIsOnline() returns correct booleans for a mix of online and offline userIds in one call', async () => {
    const onlineUserId = 'netiflyPublisher-who-online';
    const offlineUserId = 'netiflyPublisher-who-offline';
    const server = await startTestServer(() => onlineUserId);
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    await expect(publisher.whoIsOnline([onlineUserId, offlineUserId])).resolves.toEqual({
      [onlineUserId]: true,
      [offlineUserId]: false,
    });
  });

  it('send() to an offline user resolves { delivered: false, instances: 0 }', async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    await expect(
      publisher.send('netiflyPublisher-nobody-online', { type: 'x' })
    ).resolves.toEqual({ delivered: false, instances: 0 });
  });

  it("rejects a non-serializable payload with the same error netiflyServer's send() path gives", async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(publisher.send('netiflyPublisher-bad-payload', circular)).rejects.toThrow(
      'Netifly: payload for user "netiflyPublisher-bad-payload" is not JSON-serializable'
    );
  });

  it('close() resolves cleanly, and send()/isOnline() after close() throw a clear error', async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });

    await expect(publisher.close()).resolves.toBeUndefined();

    await expect(publisher.send('netiflyPublisher-after-close', { type: 'x' })).rejects.toThrow(
      'Netifly: cannot use publisher after close()'
    );
    await expect(publisher.isOnline('netiflyPublisher-after-close')).rejects.toThrow(
      'Netifly: cannot use publisher after close()'
    );
  });

  // Same root cause as RedisRouter's equivalent test (see redisDisconnect.ts):
  // ioredis's disconnect() is fire-and-forget and leaves a fallback timer
  // armed until the socket's own 'close' event clears it. A publisher that
  // has actually connected (unlike the lazyConnect-and-never-used case above)
  // needs to wait for that before close() resolves, or the still-armed timer
  // shows up as a Jest open handle.
  it('close() waits for the underlying Redis connection to fully disconnect', async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    await publisher.send('netiflyPublisher-close-waits', { type: 'x' }); // forces a real connection
    await publisher.close();
    publishers.pop(); // already closed above; afterEach would double-close otherwise

    expect((publisher as unknown as { redis: Redis }).redis.status).toBe('end');
  });

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

  it('isolates a throwing "sent" listener: send() still resolves and publishes', async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    publisher.on('sent', () => {
      throw new Error('boom-publisher-sent');
    });

    const result = await publisher.send('netiflyPublisher-sent-throws', { ok: true });
    expect(result).toEqual({ delivered: false, instances: 0 });
  });

  it('a "once" listener on "sent" still fires exactly once despite the safety wrapper', async () => {
    const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
    publishers.push(publisher);

    const calls: unknown[] = [];
    publisher.once('sent', (info) => calls.push(info));

    await publisher.send('netiflyPublisher-once-still-once', { a: 1 });
    await publisher.send('netiflyPublisher-once-still-once', { b: 2 });

    expect(calls).toHaveLength(1);
  });

  describe('notify()', () => {
    it('publishes a valid info notification that a connected server delivers to the client', async () => {
      const server = await startTestServer(() => 'netiflyPublisher-notify-user');
      servers.push(server);
      const connectedPromise = onceEvent(server.netifly, 'connect');
      const ws = await connectClient(server.port);
      clients.push(ws);
      await connectedPromise;

      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
      publishers.push(publisher);

      const messagePromise = nextMessage(ws);
      const result = await publisher.notify('netiflyPublisher-notify-user', {
        kind: 'info',
        title: 'Export ready',
        body: 'Your report has finished generating.',
      });

      expect(result).toEqual({ delivered: true, instances: 1 });
      const envelope = JSON.parse(await messagePromise);
      expect(envelope.type).toBe('notification');
      expect(envelope.data).toEqual({
        kind: 'info',
        title: 'Export ready',
        body: 'Your report has finished generating.',
      });
    });

    it('rejects an invalid notification without publishing anything', async () => {
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
      publishers.push(publisher);

      await expect(
        publisher.notify('netiflyPublisher-notify-invalid', { kind: 'info', title: '', body: 'x' })
      ).rejects.toThrow(NotificationValidationError);
    });

    it('does not run the app-level validate hook for notify()', async () => {
      const validate = jest.fn();
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL, validate });
      publishers.push(publisher);

      await publisher.notify('netiflyPublisher-notify-no-app-validate', {
        kind: 'info',
        title: 'Export ready',
        body: 'Done.',
      });
      expect(validate).not.toHaveBeenCalled();
    });

    it('throws after close(), same as send()', async () => {
      const publisher = createNetiflyPublisher({ redisUrl: REDIS_URL });
      await publisher.close();

      await expect(
        publisher.notify('netiflyPublisher-notify-after-close', {
          kind: 'info',
          title: 'Export ready',
          body: 'Done.',
        })
      ).rejects.toThrow('Netifly: cannot use publisher after close()');
    });
  });
});
