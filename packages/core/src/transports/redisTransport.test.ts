import { randomUUID } from 'node:crypto';
import { redisTransport, RedisTransportImpl, RedisTransportOptions, channelName } from './redisTransport';
import { runTransportContractTests } from './transport.contract';
import type { NetiflyTransport } from '../types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

jest.setTimeout(15000);

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

runTransportContractTests('redisTransport', () => redisTransport(REDIS_URL));

describe('redisTransport', () => {
  let transports: NetiflyTransport[];

  beforeEach(() => {
    transports = [];
  });

  afterEach(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
  });

  function create(options?: RedisTransportOptions): NetiflyTransport {
    const transport = redisTransport(REDIS_URL, options);
    transports.push(transport);
    return transport;
  }

  // NOT-18: two apps (or staging/prod) sharing one Redis instance must not
  // receive each other's notifications just because they happen to pick the
  // same userId. namespace scopes the channel name per-tenant.
  it('isolates two namespaces sharing the same Redis and userId (NOT-18)', async () => {
    const subscriberA = create({ namespace: 'tenant-a' });
    const subscriberB = create({ namespace: 'tenant-b' });
    const publisherA = create({ namespace: 'tenant-a' });
    const onMessageA = jest.fn();
    const onMessageB = jest.fn();
    subscriberA.onMessage(onMessageA);
    subscriberB.onMessage(onMessageB);

    await subscriberA.subscribe('redisTransport-shared-tenant');
    await subscriberB.subscribe('redisTransport-shared-tenant');
    await publisherA.publish(
      'redisTransport-shared-tenant',
      JSON.stringify({ hello: 'tenant-a only' })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessageA).toHaveBeenCalledWith(
      'redisTransport-shared-tenant',
      JSON.stringify({ hello: 'tenant-a only' })
    );
    expect(onMessageB).not.toHaveBeenCalled();
  });

  it('isolates a namespaced transport from a default (no-namespace) transport for the same userId (NOT-18)', async () => {
    const defaultSubscriber = create();
    const namespacedSubscriber = create({ namespace: 'tenant-a' });
    const defaultPublisher = create();
    const onMessageDefault = jest.fn();
    const onMessageNamespaced = jest.fn();
    defaultSubscriber.onMessage(onMessageDefault);
    namespacedSubscriber.onMessage(onMessageNamespaced);

    await defaultSubscriber.subscribe('redisTransport-shared-default');
    await namespacedSubscriber.subscribe('redisTransport-shared-default');
    await defaultPublisher.publish(
      'redisTransport-shared-default',
      JSON.stringify({ hello: 'default only' })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onMessageDefault).toHaveBeenCalledWith(
      'redisTransport-shared-default',
      JSON.stringify({ hello: 'default only' })
    );
    expect(onMessageNamespaced).not.toHaveBeenCalled();
  });

  // Presence must respect namespace the same way subscribe/publish do —
  // otherwise a namespaced deployment's isOnline()/whoIsOnline() would
  // silently check the wrong (unnamespaced) channel.
  it('receivers() is namespace-aware, matching subscribe/unsubscribe/publish (NOT-18 x NOT-14)', async () => {
    const namespacedSubscriber = create({ namespace: 'tenant-a' });
    const defaultRouter = create();
    namespacedSubscriber.onMessage(() => {});

    await namespacedSubscriber.subscribe('redisTransport-presence-namespaced');

    await expect(
      defaultRouter.receivers(['redisTransport-presence-namespaced'])
    ).resolves.toEqual({ 'redisTransport-presence-namespaced': 0 });

    const otherNamespaced = create({ namespace: 'tenant-a' });
    await expect(
      otherNamespaced.receivers(['redisTransport-presence-namespaced'])
    ).resolves.toEqual({ 'redisTransport-presence-namespaced': 1 });
  });

  it('claim() is namespace-aware, matching subscribe/unsubscribe/publish/receivers', async () => {
    const namespacedA = create({ namespace: 'redisTransport-claim-tenant-a' });
    const defaultTransport = create();
    // Unique per test run — claim() TTLs are real and outlive the test
    // process, so a fixed literal key would collide with a still-live claim
    // from a re-run of this suite moments earlier against a persistent Redis.
    const key = `redisTransport-claim-shared-${randomUUID()}`;

    const a = await namespacedA.claim(key, 60);
    const b = await defaultTransport.claim(key, 60);

    expect(a).toBe(true);
    expect(b).toBe(true); // different namespace — does not contend with `a`'s claim
  });

  it('surfaces connection errors via onError instead of throwing', async () => {
    const onError = jest.fn();
    const transport = redisTransport('redis://127.0.0.1:1');
    transports.push(transport);
    transport.onError(onError);

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

  it('close() waits for both Redis connections to fully disconnect, not just fire-and-forget', async () => {
    const transport = new RedisTransportImpl(REDIS_URL);
    // Not pushed to `transports` — this test calls close() itself.

    await transport.subscribe('redisTransport-close-waits');
    await transport.close();

    expect(transport['publisher'].status).toBe('end');
    expect(transport['subscriber'].status).toBe('end');
  });

  it('close() still resolves, bounded, for a transport that never successfully connected', async () => {
    const transport = redisTransport('redis://127.0.0.1:1');
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
