import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createNotifly } from './notiflyServer';
import type { NotiflyInstance } from './types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

interface TestServer {
  notifly: NotiflyInstance;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  resolveUserId: (req: http.IncomingMessage) => unknown
): Promise<TestServer> {
  const httpServer = http.createServer((_req, res) => res.end());
  const notifly = createNotifly({
    server: httpServer,
    resolveUserId: resolveUserId as never,
    redisUrl: REDIS_URL,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    notifly,
    port,
    close: async () => {
      await notifly.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/notifly`);
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

// createNotifly's returned instance emits 'connect' exactly when
// registry.add runs — right after the SUBSCRIBE await completes — so
// awaiting this event is a deterministic replacement for a fixed sleep when
// a test needs to know the initial Redis SUBSCRIBE has been acknowledged.
function onceEvent(emitter: NotiflyInstance, event: 'connect'): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

describe('createNotifly', () => {
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
    const server = await startTestServer(() => 'notiflyServer-alice');
    servers.push(server);

    const connectedPromise = onceEvent(server.notifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await server.notifly.send('notiflyServer-alice', { type: 'greeting', text: 'hi' });

    await expect(messagePromise).resolves.toBe(JSON.stringify({ type: 'greeting', text: 'hi' }));
  });

  it('delivers a send() across two server instances via Redis', async () => {
    const serverA = await startTestServer(() => 'notiflyServer-bob');
    const serverB = await startTestServer(() => 'notiflyServer-bob');
    servers.push(serverA, serverB);

    const connectedPromise = onceEvent(serverB.notifly, 'connect');
    const client = await connectClient(serverB.port);
    clients.push(client);
    await connectedPromise;

    const messagePromise = nextMessage(client);
    await serverA.notifly.send('notiflyServer-bob', { type: 'cross-instance' });

    await expect(messagePromise).resolves.toBe(JSON.stringify({ type: 'cross-instance' }));
  });

  it('delivers a send() to every connection a user has open', async () => {
    const server = await startTestServer(() => 'notiflyServer-frank');
    servers.push(server);

    const firstConnectedPromise = onceEvent(server.notifly, 'connect');
    const clientA = await connectClient(server.port);
    clients.push(clientA);
    await firstConnectedPromise;

    const secondConnectedPromise = onceEvent(server.notifly, 'connect');
    const clientB = await connectClient(server.port);
    clients.push(clientB);
    await secondConnectedPromise;

    const messageA = nextMessage(clientA);
    const messageB = nextMessage(clientB);
    await server.notifly.send('notiflyServer-frank', { type: 'multi-tab' });

    await expect(messageA).resolves.toBe(JSON.stringify({ type: 'multi-tab' }));
    await expect(messageB).resolves.toBe(JSON.stringify({ type: 'multi-tab' }));
  });

  it('is a no-op when sending to a user with no connections anywhere', async () => {
    const server = await startTestServer(() => 'notiflyServer-carol');
    servers.push(server);

    await expect(
      server.notifly.send('notiflyServer-nobody-online', { type: 'x' })
    ).resolves.toBeUndefined();
  });

  it("disconnect() closes all of a user's local connections", async () => {
    const server = await startTestServer(() => 'notiflyServer-dave');
    servers.push(server);

    const connectedPromise = onceEvent(server.notifly, 'connect');
    const client = await connectClient(server.port);
    clients.push(client);
    await connectedPromise;

    const closePromise = new Promise<void>((resolve) => client.once('close', () => resolve()));
    server.notifly.disconnect('notiflyServer-dave');

    await closePromise;
  });

  it('close() resolves even while a client is still connected', async () => {
    const server = await startTestServer(() => 'notiflyServer-henry');
    servers.push(server);

    const connectedPromise = onceEvent(server.notifly, 'connect');
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
    const server = await startTestServer(() => 'notiflyServer-gina');
    servers.push(server);

    await server.notifly.close();
    await expect(server.notifly.send('notiflyServer-gina', { type: 'x' })).rejects.toThrow(
      'Notifly: cannot send after close()'
    );

    servers.pop(); // already closed above; skip afterEach double-close
  });
});
