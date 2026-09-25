import { RedisRouter, channelName } from './redisRouter';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

describe('channelName', () => {
  it('formats the per-user channel name', () => {
    expect(channelName('alice')).toBe('netifly:user:alice');
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

  function createRouter(onMessage: (userId: string, rawMessage: string) => void): RedisRouter {
    const router = new RedisRouter({ redisUrl: REDIS_URL, onMessage });
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

  it('rejects a non-serializable payload with a clear error', async () => {
    const publisherRouter = createRouter(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(publisherRouter.publish('redisRouter-zoe', circular)).rejects.toThrow(
      'Netifly: payload for user "redisRouter-zoe" is not JSON-serializable'
    );
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
