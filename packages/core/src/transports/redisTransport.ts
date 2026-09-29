import Redis from 'ioredis';
import type { NetiflyTransport, UserId } from '../types';
import { disconnectRedis } from '../redisDisconnect';

export interface RedisTransportOptions {
  /**
   * Scopes this transport's channel names to `netifly:<namespace>:user:<id>`
   * instead of the default `netifly:user:<id>`. Set this when multiple apps
   * (or environments, e.g. staging vs. prod) share one Redis instance —
   * common on Upstash/Redis Cloud free tiers — so they don't receive each
   * other's notifications. Omit for the default, unnamespaced shape.
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

/**
 * Redis pub/sub-backed NetiflyTransport — the default. Exported as a class
 * (rather than a closure, like memoryTransport()) so its own test file can
 * assert on internal ioredis connection state via bracket-notation access
 * to `publisher`/`subscriber` — the same pattern the old RedisRouter class
 * used. Prefer the `redisTransport()` factory function everywhere else.
 *
 * Ref-counting for overlapping subscribe()/unsubscribe() calls is NOT
 * handled here — that's RefCountedTransport's job, applied by
 * createNetifly() around whichever raw transport it's given (NOT-20 design
 * spec §5), so this implementation assumes each subscribe()/unsubscribe()
 * call it receives is already deduplicated.
 */
export class RedisTransportImpl implements NetiflyTransport {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly namespace: string | undefined;
  private onMessageCb: ((userId: UserId, message: string) => void) | undefined;

  constructor(url: string, options: RedisTransportOptions = {}) {
    this.namespace = options.namespace;
    this.publisher = new Redis(url);
    // enableReadyCheck is disabled here because ioredis's own connection
    // handshake sends an INFO command to verify readiness, and that command
    // can race against our SUBSCRIBE call below. If SUBSCRIBE reaches the
    // server first, the connection enters subscriber-only mode and Redis
    // rejects the in-flight INFO command ("ERR Can't execute 'info'"), which
    // ioredis then reports as a fatal connection error. This connection is
    // subscribe-only, so the readiness check serves no purpose here.
    this.subscriber = new Redis(url, { enableReadyCheck: false });

    this.subscriber.on('message', (channel, message) => {
      const userId = this.userIdFromChannel(channel);
      if (userId !== null) {
        this.onMessageCb?.(userId, message);
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
    await this.subscriber.subscribe(this.channelFor(userId));
  }

  async unsubscribe(userId: UserId): Promise<void> {
    await this.subscriber.unsubscribe(this.channelFor(userId));
  }

  async publish(userId: UserId, message: string): Promise<{ receivers: number }> {
    const receivers = await this.publisher.publish(this.channelFor(userId), message);
    return { receivers };
  }

  // One NUMSUB call for many channels (NOT-14), rather than looping a
  // single-channel call per userId. Redis replies with a flat
  // [channel1, count1, channel2, count2, ...] array in the same order the
  // channels were requested, so the reply is zipped back to the original
  // userIds by index. Run on the publisher, not the subscriber — the
  // subscriber connection may be in RESP2 subscribe-mode depending on
  // active subscriptions, while the publisher is always a plain client safe
  // for arbitrary commands.
  async receivers(userIds: UserId[]): Promise<Record<UserId, number>> {
    if (userIds.length === 0) return {};

    const channels = userIds.map((userId) => this.channelFor(userId));
    const reply = (await this.publisher.call('PUBSUB', 'NUMSUB', ...channels)) as (
      | string
      | number
    )[];

    const counts: Record<UserId, number> = {};
    userIds.forEach((userId, index) => {
      counts[userId] = reply[index * 2 + 1] as number;
    });
    return counts;
  }

  onMessage(cb: (userId: UserId, message: string) => void): void {
    this.onMessageCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.publisher.on('error', cb);
    this.subscriber.on('error', cb);
  }

  async close(): Promise<void> {
    await Promise.all([disconnectRedis(this.publisher), disconnectRedis(this.subscriber)]);
  }
}

export function redisTransport(url: string, options?: RedisTransportOptions): NetiflyTransport {
  return new RedisTransportImpl(url, options);
}
