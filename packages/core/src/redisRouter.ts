import Redis from 'ioredis';
import type { UserId } from './connectionRegistry';

export interface RedisRouterOptions {
  redisUrl: string;
  onMessage: (userId: UserId, rawMessage: string) => void;
  onError?: (error: Error) => void;
}

const CHANNEL_PREFIX = 'notifly:user:';

export function channelName(userId: UserId): string {
  return `${CHANNEL_PREFIX}${userId}`;
}

function userIdFromChannel(channel: string): UserId | null {
  return channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;
}

export class RedisRouter {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(options: RedisRouterOptions) {
    this.publisher = new Redis(options.redisUrl);
    this.subscriber = new Redis(options.redisUrl);

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
    await this.subscriber.subscribe(channelName(userId));
  }

  async unsubscribe(userId: UserId): Promise<void> {
    await this.subscriber.unsubscribe(channelName(userId));
  }

  async publish(userId: UserId, payload: unknown): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      const message = `Notifly: payload for user "${userId}" is not JSON-serializable`;
      const serializationError = new Error(message);
      (serializationError as Error & { cause?: unknown }).cause = error;
      throw serializationError;
    }
    await this.publisher.publish(channelName(userId), serialized);
  }

  async close(): Promise<void> {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
