import Redis from 'ioredis';
import { RedisRouter, RedisRouterOptions, channelName } from './redisRouter';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

async function numSubscribers(channel: string): Promise<number> {
  const client = new Redis(REDIS_URL);
  try {
    const [, count] = (await client.call('PUBSUB', 'NUMSUB', channel)) as [string, number];
    return count;
  } finally {
    client.disconnect();
  }
}

describe('channelName', () => {
  it('formats the per-user channel name', () => {
    expect(channelName('alice')).toBe('netifly:user:alice');
  });

  it('formats a namespaced per-user channel name (NOT-18)', () => {
    expect(channelName('alice', 'tenant-a')).toBe('netifly:tenant-a:user:alice');
  });

  it('throws for an empty userId (NOT-18)', () => {
    expect(() => channelName('')).toThrow(
      'Netifly: userId must be a non-empty string of at most 256 characters'
    );
  });

  it('throws for a userId over the max length (NOT-18)', () => {
    expect(() => channelName('a'.repeat(257))).toThrow(
      'Netifly: userId must be a non-empty string of at most 256 characters'
    );
  });
});

describe('RedisRouter', () => {
  let routers: RedisRouter[];

  beforeEach(() => {
    routers = [];
  });

  afterEach(async () => {
    await Promise.all(routers.map((router) => router.close()));
  });

  function createRouter(
    onMessage: (userId: string, rawMessage: string) => void,
    options: Partial<Omit<RedisRouterOptions, 'redisUrl' | 'onMessage'>> = {}
  ): RedisRouter {
    const router = new RedisRouter({ redisUrl: REDIS_URL, onMessage, ...options });
    routers.push(router);
    return router;
  }

  it('delivers a published message to a subscribed router', async () => {
    const received: Array<{ userId: string; rawMessage: string }> = [];
    let resolveReceived: () => void;
    const receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    const subscriberRouter = createRouter((userId, rawMessage) => {
      received.push({ userId, rawMessage });
      resolveReceived();
    });
    const publisherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('redisRouter-alice');
    await publisherRouter.publish('redisRouter-alice', { hello: 'world' });
    await receivedPromise;

    expect(received).toEqual([
      { userId: 'redisRouter-alice', rawMessage: JSON.stringify({ hello: 'world' }) },
    ]);
  });

  it('does not deliver to a userId nobody has subscribed to', async () => {
    const onMessage = jest.fn();
    const publisherRouter = createRouter(onMessage);

    await publisherRouter.publish('redisRouter-nobody-home', { hello: 'world' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    const onMessage = jest.fn();
    const subscriberRouter = createRouter(onMessage);
    const publisherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('redisRouter-bob');
    await subscriberRouter.unsubscribe('redisRouter-bob');
    await publisherRouter.publish('redisRouter-bob', { hello: 'world' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessage).not.toHaveBeenCalled();
  });

  // NOT-5: two callers subscribing on behalf of the same userId (e.g. two
  // WebSocket connections for the same user) must not be able to tear down
  // each other's subscription. Regression test for the race where a second
  // subscriber's unsubscribe (or, as here, the first's while a second is
  // still active) silently drops the channel out from under the survivor.
  it('keeps a channel subscribed for a second caller after the first of two overlapping subscribers unsubscribes', async () => {
    const onMessage = jest.fn();
    const subscriberRouter = createRouter(onMessage);
    const publisherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('redisRouter-overlap');
    await subscriberRouter.subscribe('redisRouter-overlap'); // second overlapping subscriber
    await subscriberRouter.unsubscribe('redisRouter-overlap'); // first subscriber's cleanup

    await publisherRouter.publish('redisRouter-overlap', { hello: 'still here' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessage).toHaveBeenCalledWith(
      'redisRouter-overlap',
      JSON.stringify({ hello: 'still here' })
    );
  });

  it('only stops delivering once every overlapping subscriber has unsubscribed', async () => {
    const onMessage = jest.fn();
    const subscriberRouter = createRouter(onMessage);
    const publisherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('redisRouter-overlap-close');
    await subscriberRouter.subscribe('redisRouter-overlap-close');
    await subscriberRouter.unsubscribe('redisRouter-overlap-close');
    await subscriberRouter.unsubscribe('redisRouter-overlap-close');

    await publisherRouter.publish('redisRouter-overlap-close', { hello: 'gone' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessage).not.toHaveBeenCalled();
    expect(await numSubscribers(channelName('redisRouter-overlap-close'))).toBe(0);
  });

  it('rejects a non-serializable payload with a clear error', async () => {
    const publisherRouter = createRouter(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(publisherRouter.publish('redisRouter-zoe', circular)).rejects.toThrow(
      'Netifly: payload for user "redisRouter-zoe" is not JSON-serializable'
    );
  });

  // NOT-18: two apps (or staging/prod) sharing one Redis instance must not
  // receive each other's notifications just because they happen to pick the
  // same userId. namespace scopes the channel name per-tenant.
  it('isolates two namespaces sharing the same Redis and userId (NOT-18)', async () => {
    const onMessageA = jest.fn();
    const onMessageB = jest.fn();
    const subscriberA = createRouter(onMessageA, { namespace: 'tenant-a' });
    const subscriberB = createRouter(onMessageB, { namespace: 'tenant-b' });
    const publisherA = createRouter(() => {}, { namespace: 'tenant-a' });

    await subscriberA.subscribe('redisRouter-shared-tenant');
    await subscriberB.subscribe('redisRouter-shared-tenant');
    await publisherA.publish('redisRouter-shared-tenant', { hello: 'tenant-a only' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessageA).toHaveBeenCalledWith(
      'redisRouter-shared-tenant',
      JSON.stringify({ hello: 'tenant-a only' })
    );
    expect(onMessageB).not.toHaveBeenCalled();
  });

  it('isolates a namespaced router from a default (no-namespace) router for the same userId (NOT-18)', async () => {
    const onMessageDefault = jest.fn();
    const onMessageNamespaced = jest.fn();
    const defaultSubscriber = createRouter(onMessageDefault);
    const namespacedSubscriber = createRouter(onMessageNamespaced, { namespace: 'tenant-a' });
    const defaultPublisher = createRouter(() => {});

    await defaultSubscriber.subscribe('redisRouter-shared-default');
    await namespacedSubscriber.subscribe('redisRouter-shared-default');
    await defaultPublisher.publish('redisRouter-shared-default', { hello: 'default only' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessageDefault).toHaveBeenCalledWith(
      'redisRouter-shared-default',
      JSON.stringify({ hello: 'default only' })
    );
    expect(onMessageNamespaced).not.toHaveBeenCalled();
  });

  it('surfaces connection errors via onError instead of throwing', async () => {
    const onError = jest.fn();
    const router = new RedisRouter({
      redisUrl: 'redis://127.0.0.1:1',
      onMessage: () => {},
      onError,
    });
    routers.push(router);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (onError.mock.calls.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    expect(onError).toHaveBeenCalled();
  });
});
