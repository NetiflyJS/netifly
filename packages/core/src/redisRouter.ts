import Redis from 'ioredis';
import type { UserId } from './connectionRegistry';

export interface RedisRouterOptions {
  redisUrl: string;
  onMessage: (userId: UserId, rawMessage: string) => void;
  onError?: (error: Error) => void;
}

const CHANNEL_PREFIX = 'netifly:user:';

export function channelName(userId: UserId): string {
  return `${CHANNEL_PREFIX}${userId}`;
}

function userIdFromChannel(channel: string): UserId | null {
  return channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;
}

export class RedisRouter {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  // Multiple callers (e.g. two WebSocket connections for the same user) can
  // subscribe on behalf of the same userId concurrently. Ref-counting here,
  // rather than relying on callers to know whether anyone else still wants
  // the channel, is what makes subscribe/unsubscribe safe to call once per
  // caller in any interleaving — see NOT-5.
  private readonly refCounts = new Map<UserId, number>();

  constructor(options: RedisRouterOptions) {
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
      const userId = userIdFromChannel(channel);
      if (userId !== null) {
        options.onMessage(userId, rawMessage);
      }
    });
  }

  async subscribe(userId: UserId): Promise<void> {
    const count = this.refCounts.get(userId) ?? 0;
    this.refCounts.set(userId, count + 1);
    if (count > 0) return; // someone else already holds this channel open

    try {
      await this.subscriber.subscribe(channelName(userId));
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
        await this.subscriber.unsubscribe(channelName(userId));
      }
      return;
    }
    this.refCounts.set(userId, count - 1);
  }

  async publish(userId: UserId, payload: unknown): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      const message = `Netifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }
    await this.publisher.publish(channelName(userId), serialized);
  }

  // Presence (NOT-14): every online user has a subscribed Redis channel, so
  // PUBSUB NUMSUB on that channel gives cluster-wide presence with no extra
  // state. Run on the publisher, not the subscriber — the subscriber
  // connection may be in RESP2 subscribe-mode depending on active
  // subscriptions, while the publisher is always a plain client safe for
  // arbitrary commands.
  async numSubscribers(userId: UserId): Promise<number> {
    const [, count] = (await this.publisher.call('PUBSUB', 'NUMSUB', channelName(userId))) as [
      string,
      number,
    ];
    return count;
  }

  // One NUMSUB call for many channels, per the ticket, rather than looping
  // numSubscribers() per userId. Redis replies with a flat
  // [channel1, count1, channel2, count2, ...] array in the same order the
  // channels were requested, so the reply is zipped back to the original
  // userIds by index rather than parsed back out of the channel names —
  // simpler, and doesn't couple this to channelName's exact prefix format.
  async numSubscribersMany(userIds: UserId[]): Promise<Record<UserId, number>> {
    if (userIds.length === 0) return {};

    const channels = userIds.map(channelName);
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

  async close(): Promise<void> {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
