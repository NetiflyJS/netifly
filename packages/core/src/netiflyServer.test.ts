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

// createNetifly's returned instance emits 'connect' exactly when
// registry.add runs — right after the SUBSCRIBE await completes — so
// awaiting this event is a deterministic replacement for a fixed sleep when
// a test needs to know the initial Redis SUBSCRIBE has been acknowledged.
function onceEvent(emitter: NetiflyInstance, event: 'connect'): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
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
    const server = await startTestServer(() => 'netiflyServer-alice');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-alice', { type: 'greeting', text: 'hi' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope.data).toEqual({ type: 'greeting', text: 'hi' });
  });

  it('wraps a two-arg send() payload in an envelope with type "message"', async () => {
    const server = await startTestServer(() => 'netiflyServer-envelope-message');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-envelope-message', { text: 'hi' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope).toMatchObject({
      v: 1,
      type: 'message',
      data: { text: 'hi' },
    });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.ts).toBe('number');
  });

  it('wraps a three-arg send() type/data in an envelope with the given type', async () => {
    const server = await startTestServer(() => 'netiflyServer-envelope-typed');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.netifly.send('netiflyServer-envelope-typed', 'comment.created', { commentId: 42 });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope).toMatchObject({
      v: 1,
      type: 'comment.created',
      data: { commentId: 42 },
    });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.ts).toBe('number');
  });

  it('generates unique, strictly increasing envelope ids for sequential sends', async () => {
    const server = await startTestServer(() => 'netiflyServer-envelope-ids');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const COUNT = 50;
    const messages: string[] = [];
    const allReceived = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        messages.push(data.toString());
        if (messages.length === COUNT) resolve();
      });
    });

    for (let i = 0; i < COUNT; i++) {
      await server.netifly.send('netiflyServer-envelope-ids', { i });
    }
    await allReceived;

    const ids: string[] = messages.map((m) => JSON.parse(m).id as string);
    expect(new Set(ids).size).toBe(COUNT);
    expect(ids).toEqual([...ids].sort());
  });

  it('delivers a send() across two server instances via Redis', async () => {
    const serverA = await startTestServer(() => 'netiflyServer-bob');
    const serverB = await startTestServer(() => 'netiflyServer-bob');
    servers.push(serverA, serverB);

    const connectedPromise = onceEvent(serverB.netifly, 'connect');
    const client = await connectClient(serverB.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await serverA.netifly.send('netiflyServer-bob', { type: 'cross-instance' });

    const envelope = JSON.parse(await messagePromise);
    expect(envelope.data).toEqual({ type: 'cross-instance' });
  });

  it('delivers a send() to every connection a user has open', async () => {
    const server = await startTestServer(() => 'netiflyServer-frank');
    servers.push(server);

    const firstConnectedPromise = onceEvent(server.netifly, 'connect');
    const clientA = await connectClient(server.port);
    clients.push(clientA);
    await firstConnectedPromise;

    const secondConnectedPromise = onceEvent(server.netifly, 'connect');
    const clientB = await connectClient(server.port);
    clients.push(clientB);
    await secondConnectedPromise;

    const messageA = nextMessage(clientA);
    const messageB = nextMessage(clientB);
    await server.netifly.send('netiflyServer-frank', { type: 'multi-tab' });

    expect(JSON.parse(await messageA).data).toEqual({ type: 'multi-tab' });
    expect(JSON.parse(await messageB).data).toEqual({ type: 'multi-tab' });
  });

  it('is a no-op when sending to a user with no connections anywhere', async () => {
    const server = await startTestServer(() => 'netiflyServer-carol');
    servers.push(server);

    await expect(
      server.netifly.send('netiflyServer-nobody-online', { type: 'x' })
    ).resolves.toBeUndefined();
  });

  it("disconnect() closes all of a user's local connections", async () => {
    const server = await startTestServer(() => 'netiflyServer-dave');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const closePromise = new Promise<void>((resolve) => client.once('close', () => resolve()));
    server.netifly.disconnect('netiflyServer-dave');

    await closePromise;
  });

  it('close() resolves even while a client is still connected', async () => {
    const server = await startTestServer(() => 'netiflyServer-henry');
    servers.push(server);

    const connectedPromise = onceEvent(server.netifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    // A regression here (close() hanging because WebSocketServer#close()
    // never gets its tracked clients removed) should fail this test loudly
    // and quickly rather than hanging the whole run for jest.setTimeout's
    // full 15s.
    await expect(
      Promise.race([
        server.close(),
        wait(3000).then(() => {
          throw new Error('close() did not resolve within 3000ms with a client still connected');
        }),
      ])
    ).resolves.toBeUndefined();

    servers.pop(); // already closed above; skip afterEach double-close
  });

  it('rejects send() after close()', async () => {
    const server = await startTestServer(() => 'netiflyServer-gina');
    servers.push(server);

    await server.netifly.close();
    await expect(server.netifly.send('netiflyServer-gina', { type: 'x' })).rejects.toThrow(
      'Netifly: cannot send after close()'
    );

    servers.pop(); // already closed above; skip afterEach double-close
  });
});
