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
    const server = await startTestServer(() => 'alice');
    servers.push(server);

    const client = await connectClient(server.port);
    clients.push(client);
    await wait(100); // allow the initial Redis SUBSCRIBE to be acknowledged

    const messagePromise = nextMessage(client);
    await server.notifly.send('alice', { type: 'greeting', text: 'hi' });

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
    await serverA.notifly.send('bob', { type: 'cross-instance' });

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
    await server.notifly.send('frank', { type: 'multi-tab' });

    await expect(messageA).resolves.toBe(JSON.stringify({ type: 'multi-tab' }));
    await expect(messageB).resolves.toBe(JSON.stringify({ type: 'multi-tab' }));
  });

  it('is a no-op when sending to a user with no connections anywhere', async () => {
    const server = await startTestServer(() => 'carol');
    servers.push(server);

    await expect(server.notifly.send('nobody-online', { type: 'x' })).resolves.toBeUndefined();
  });

  it("disconnect() closes all of a user's local connections", async () => {
    const server = await startTestServer(() => 'dave');
    servers.push(server);

    const client = await connectClient(server.port);
    clients.push(client);
    await wait(100);

    const closePromise = new Promise<void>((resolve) => client.once('close', () => resolve()));
    server.notifly.disconnect('dave');

    await closePromise;
  });

  it('rejects send() after close()', async () => {
    const server = await startTestServer(() => 'gina');
    servers.push(server);

    await server.notifly.close();
    await expect(server.notifly.send('gina', { type: 'x' })).rejects.toThrow(
      'Notifly: cannot send after close()'
    );

    servers.pop(); // already closed above; skip afterEach double-close
  });
});
