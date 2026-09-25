import type { IncomingMessage, Server as HttpServer } from 'node:http';

export type UserId = string;

export const ENVELOPE_VERSION = 1;

export interface Envelope<T = unknown> {
  v: typeof ENVELOPE_VERSION;
  id: string;
  type: string;
  data: T;
  ts: number;
}

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
  send<T>(userId: UserId, payload: T): Promise<void>;
  send<T>(userId: UserId, type: string, data: T): Promise<void>;
  disconnect(userId: UserId): void;
  on(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  close(): Promise<void>;
}
