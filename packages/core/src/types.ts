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

/**
 * Controls the CSWSH origin check on WebSocket upgrades. Omit to allow only
 * same-host origins (Origin's host must match the request's Host header).
 * An array matches strings exactly and tests RegExp entries against the
 * header; a function gets full control, including over a missing Origin
 * (every other form allows a missing Origin by default); `'*'` disables the
 * check entirely.
 */
export type AllowedOrigins =
  | (string | RegExp)[]
  | ((origin: string | undefined) => boolean)
  | '*';

export interface CreateNetiflyOptions {
  server: HttpServer;
  resolveUserId: ResolveUserId;
  redisUrl?: string;
  path?: string;
  allowedOrigins?: AllowedOrigins;
}

/** Emitted via the `reject` event when the origin check rejects an upgrade. */
export interface RejectInfo {
  reason: 'origin';
  status: number;
  origin: string | undefined;
  req: IncomingMessage;
}

export interface NetiflyInstance {
  send<T>(userId: UserId, payload: T): Promise<void>;
  send<T>(userId: UserId, type: string, data: T): Promise<void>;
  disconnect(userId: UserId): void;
  on(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'reject', listener: (info: RejectInfo) => void): this;
  once(event: 'connect' | 'disconnect', listener: (userId: UserId) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'reject', listener: (info: RejectInfo) => void): this;
  close(): Promise<void>;
}
