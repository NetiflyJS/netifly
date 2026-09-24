// packages/express/src/index.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import WebSocket from 'ws';
import { attachNotifly } from './index';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

describe('attachNotifly', () => {
  it('creates an http.Server from the Express app and wires notifly to it', async () => {
    const app = express();
    app.get('/health', (_req, res) => res.send('ok'));

    const { server, notifly } = attachNotifly(app, {
      resolveUserId: () => 'eve',
      redisUrl: REDIS_URL,
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const httpResponse = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await httpResponse.text()).toBe('ok');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/notifly`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const messagePromise = new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
    });
    await notifly.send('eve', { hello: 'express' });
    await expect(messagePromise).resolves.toBe(JSON.stringify({ hello: 'express' }));

    ws.close();
    await notifly.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reuses a server passed explicitly instead of creating a new one', async () => {
    const app = express();
    const existingServer = http.createServer(app);

    const { server, notifly } = attachNotifly(app, {
      resolveUserId: () => null,
      redisUrl: REDIS_URL,
      server: existingServer,
    });

    expect(server).toBe(existingServer);
    await notifly.close();
  });
});
