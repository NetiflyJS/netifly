// packages/express/src/index.ts
import http from 'node:http';
import type { Express } from 'express';
import { createNetifly } from '@netiflyjs/core';
import type { CreateNetiflyOptions, NetiflyInstance } from '@netiflyjs/core';

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
