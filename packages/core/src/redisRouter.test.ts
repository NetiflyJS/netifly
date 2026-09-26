import Redis from 'ioredis';
import { RedisRouter, channelName } from './redisRouter';

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

  // NOT-14: presence is derived from PUBSUB NUMSUB on the per-user channel —
  // every online user has a subscribed channel, so this gives cross-cluster
  // presence with no extra state. Run on the publisher connection since the
  // subscriber may be in RESP2 subscribe-mode.
  it('numSubscribers() reflects an active subscriber and returns 0 for an unsubscribed userId', async () => {
    const subscriberRouter = createRouter(() => {});
    const otherRouter = createRouter(() => {});

    await expect(otherRouter.numSubscribers('redisRouter-presence-nobody')).resolves.toBe(0);

    await subscriberRouter.subscribe('redisRouter-presence-solo');
    await expect(otherRouter.numSubscribers('redisRouter-presence-solo')).resolves.toBe(1);
  });

  it('numSubscribersMany() returns counts for every requested userId via a single NUMSUB call', async () => {
    const subscriberRouter = createRouter(() => {});
    const otherRouter = createRouter(() => {});

    await subscriberRouter.subscribe('redisRouter-presence-many-a');

    await expect(
      otherRouter.numSubscribersMany([
        'redisRouter-presence-many-a',
        'redisRouter-presence-many-b',
      ])
    ).resolves.toEqual({
      'redisRouter-presence-many-a': 1,
      'redisRouter-presence-many-b': 0,
    });
  });

  it('numSubscribersMany([]) resolves {} without calling Redis', async () => {
    const otherRouter = createRouter(() => {});
    const callSpy = jest.spyOn(otherRouter['publisher'], 'call');

    await expect(otherRouter.numSubscribersMany([])).resolves.toEqual({});
    expect(callSpy).not.toHaveBeenCalled();
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
