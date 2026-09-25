// packages/express/src/index.ts
import http from 'node:http';
import type { Express } from 'express';
import { createNotifly } from '@netiflyjs/core';
import type { CreateNotiflyOptions, NotiflyInstance } from '@netiflyjs/core';

export interface AttachNotiflyOptions extends Omit<CreateNotiflyOptions, 'server'> {
  server?: http.Server;
}

export interface AttachNotiflyResult {
  server: http.Server;
  notifly: NotiflyInstance;
}

export function attachNotifly(app: Express, options: AttachNotiflyOptions): AttachNotiflyResult {
  const server = options.server ?? http.createServer(app);
  const notifly = createNotifly({ ...options, server });
  return { server, notifly };
}
