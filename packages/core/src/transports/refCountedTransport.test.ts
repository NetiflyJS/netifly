import { RefCountedTransport } from './refCountedTransport';
import type { NetiflyTransport, UserId } from '../types';

function createFakeTransport(): NetiflyTransport & {
  subscribeCalls: UserId[];
  unsubscribeCalls: UserId[];
} {
  const subscribeCalls: UserId[] = [];
  const unsubscribeCalls: UserId[] = [];
  return {
    subscribeCalls,
    unsubscribeCalls,
    async subscribe(userId) {
      subscribeCalls.push(userId);
    },
    async unsubscribe(userId) {
      unsubscribeCalls.push(userId);
    },
    async publish() {
      return { receivers: 0 };
    },
    async receivers() {
      return {};
    },
    onMessage() {},
    onError() {},
    async close() {},
  };
}

describe('RefCountedTransport', () => {
  it('subscribes the raw transport only once for two calls on behalf of the same userId', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-a');
    await wrapped.subscribe('user-a');

    expect(fake.subscribeCalls).toEqual(['user-a']);
  });

  // NOT-5: two callers subscribing on behalf of the same userId (e.g. two
  // WebSocket connections for the same user) must not be able to tear down
  // each other's subscription.
  it('keeps the raw transport subscribed for a second caller after the first of two overlapping subscribers unsubscribes', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-overlap');
    await wrapped.subscribe('user-overlap'); // second overlapping subscriber
    await wrapped.unsubscribe('user-overlap'); // first subscriber's cleanup

    expect(fake.unsubscribeCalls).toEqual([]);
  });

  it('only unsubscribes the raw transport once every overlapping subscriber has unsubscribed', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-overlap-close');
    await wrapped.subscribe('user-overlap-close');
    await wrapped.unsubscribe('user-overlap-close');
    await wrapped.unsubscribe('user-overlap-close');

    expect(fake.unsubscribeCalls).toEqual(['user-overlap-close']);
  });

  it('re-subscribes the raw transport after a full unsubscribe/subscribe cycle', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-cycle');
    await wrapped.unsubscribe('user-cycle');
    await wrapped.subscribe('user-cycle');

    expect(fake.subscribeCalls).toEqual(['user-cycle', 'user-cycle']);
  });

  it('rolls back the ref count if the raw transport rejects subscribe(), so the next call retries it', async () => {
    const fake = createFakeTransport();
    fake.subscribe = jest.fn().mockRejectedValueOnce(new Error('boom'));
    const wrapped = new RefCountedTransport(fake);

    await expect(wrapped.subscribe('user-fail')).rejects.toThrow('boom');

    fake.subscribe = jest.fn().mockResolvedValue(undefined);
    await wrapped.subscribe('user-fail');
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
  });

  it('passes publish/receivers/onMessage/onError/close straight through to the raw transport', async () => {
    const fake = createFakeTransport();
    fake.publish = jest.fn().mockResolvedValue({ receivers: 2 });
    fake.receivers = jest.fn().mockResolvedValue({ a: 1 });
    fake.onMessage = jest.fn();
    fake.onError = jest.fn();
    fake.close = jest.fn().mockResolvedValue(undefined);
    const wrapped = new RefCountedTransport(fake);
    const onMessageCb = () => {};
    const onErrorCb = () => {};

    await expect(wrapped.publish('a', 'msg')).resolves.toEqual({ receivers: 2 });
    await expect(wrapped.receivers(['a'])).resolves.toEqual({ a: 1 });
    wrapped.onMessage(onMessageCb);
    wrapped.onError(onErrorCb);
    await wrapped.close();

    expect(fake.publish).toHaveBeenCalledWith('a', 'msg');
    expect(fake.receivers).toHaveBeenCalledWith(['a']);
    expect(fake.onMessage).toHaveBeenCalledWith(onMessageCb);
    expect(fake.onError).toHaveBeenCalledWith(onErrorCb);
    expect(fake.close).toHaveBeenCalled();
  });

  it('close() clears its ref-count map — a subsequent subscribe() after close() subscribes the raw transport again', async () => {
    const fake = createFakeTransport();
    const wrapped = new RefCountedTransport(fake);

    await wrapped.subscribe('user-after-close');
    await wrapped.subscribe('user-after-close');
    await wrapped.close();

    await wrapped.subscribe('user-after-close');
    expect(fake.subscribeCalls).toEqual(['user-after-close', 'user-after-close']);
  });
});
