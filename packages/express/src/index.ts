// packages/express/src/index.ts
import http from 'node:http';
import type { Express } from 'express';
import { createNetifly } from '@netiflyjs/core';
import type { CreateNetiflyOptions, NetiflyInstance } from '@netiflyjs/core';

// Augments Express's Request type so `req.netifly` is recognized wherever
// @netiflyjs/express is imported. attachNetifly() mounts a middleware that
// populates this on every request (see below).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- required to augment Express's Request type
  namespace Express {
    interface Request {
      netifly: NetiflyInstance;
    }
  }
}

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

  // Convenience: expose the netifly instance on every request as `req.netifly`,
  // so route handlers can call `req.netifly.send(...)` without threading the
  // `netifly` variable returned above through the rest of the app.
  app.use((req, _res, next) => {
    req.netifly = netifly;
    next();
  });

  return { server, netifly };
}
