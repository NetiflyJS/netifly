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
  once(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  close(): Promise<void>;
}
