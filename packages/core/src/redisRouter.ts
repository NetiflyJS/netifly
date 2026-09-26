import Redis from 'ioredis';
import type { UserId } from './connectionRegistry';

export interface RedisRouterOptions {
  redisUrl: string;
  onMessage: (userId: UserId, rawMessage: string) => void;
  onError?: (error: Error) => void;
  /**
   * Scopes this router's channel names to `netifly:<namespace>:user:<id>`
   * instead of the default `netifly:user:<id>`. Set this when multiple apps
   * (or environments, e.g. staging vs. prod) share one Redis instance — common
   * on Upstash/Redis Cloud free tiers — so they don't receive each other's
   * notifications. Omit for the default, unnamespaced shape.
   */
  namespace?: string;
}

const CHANNEL_PREFIX = 'netifly:';
const CHANNEL_USER_SEGMENT = 'user:';
const MAX_USER_ID_LENGTH = 256;

function assertValidUserId(userId: UserId): void {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
    throw new Error(
      `Netifly: userId must be a non-empty string of at most ${MAX_USER_ID_LENGTH} characters`
    );
  }
}

function channelPrefix(namespace?: string): string {
  return namespace
    ? `${CHANNEL_PREFIX}${namespace}:${CHANNEL_USER_SEGMENT}`
    : `${CHANNEL_PREFIX}${CHANNEL_USER_SEGMENT}`;
}

export function channelName(userId: UserId, namespace?: string): string {
  assertValidUserId(userId);
  return `${channelPrefix(namespace)}${userId}`;
}

export class RedisRouter {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly namespace: string | undefined;
  // Multiple callers (e.g. two WebSocket connections for the same user) can
  // subscribe on behalf of the same userId concurrently. Ref-counting here,
  // rather than relying on callers to know whether anyone else still wants
  // the channel, is what makes subscribe/unsubscribe safe to call once per
  // caller in any interleaving — see NOT-5.
  private readonly refCounts = new Map<UserId, number>();

  constructor(options: RedisRouterOptions) {
    this.namespace = options.namespace;
    this.publisher = new Redis(options.redisUrl);
    // enableReadyCheck is disabled here because ioredis's own connection
    // handshake sends an INFO command to verify readiness, and that command
    // can race against our SUBSCRIBE call below. If SUBSCRIBE reaches the
    // server first, the connection enters subscriber-only mode and Redis
    // rejects the in-flight INFO command ("ERR Can't execute 'info'"),
    // which ioredis then reports as a fatal connection error. This
    // connection is subscribe-only, so the readiness check serves no
    // purpose here.
    this.subscriber = new Redis(options.redisUrl, { enableReadyCheck: false });

    if (options.onError) {
      this.publisher.on('error', options.onError);
      this.subscriber.on('error', options.onError);
    }

    this.subscriber.on('message', (channel, rawMessage) => {
      const userId = this.userIdFromChannel(channel);
      if (userId !== null) {
        options.onMessage(userId, rawMessage);
      }
    });
  }

  private userIdFromChannel(channel: string): UserId | null {
    const prefix = channelPrefix(this.namespace);
    return channel.startsWith(prefix) ? channel.slice(prefix.length) : null;
  }

  private channelFor(userId: UserId): string {
    return channelName(userId, this.namespace);
  }

  async subscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    this.refCounts.set(userId, count + 1);
    if (count > 0) return; // someone else already holds this channel open

    try {
      await this.subscriber.subscribe(this.channelFor(userId));
    } catch (error) {
      const current = this.refCounts.get(userId) ?? 1;
      if (current <= 1) this.refCounts.delete(userId);
      else this.refCounts.set(userId, current - 1);
      throw error;
    }
  }

  async unsubscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    if (count <= 1) {
      this.refCounts.delete(userId);
      if (count === 1) {
        await this.subscriber.unsubscribe(this.channelFor(userId));
      }
      return;
    }
    this.refCounts.set(userId, count - 1);
  }

  async publish(userId: UserId, payload: unknown): Promise<void> {
    const channel = this.channelFor(userId);
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      const message = `Netifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }
    await this.publisher.publish(channel, serialized);
  }

  async close(): Promise<void> {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
