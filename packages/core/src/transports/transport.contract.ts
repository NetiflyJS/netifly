import type { NetiflyTransport, UserId } from '../types';

/**
 * The behavioral contract every `NetiflyTransport` implementation must
 * satisfy (NOT-20 design spec §10), run against both `redisTransport` and
 * `memoryTransport` from their own test files. Ref-counted overlapping
 * subscribe()/unsubscribe() is deliberately NOT part of this contract —
 * that's `RefCountedTransport`'s job (see `refCountedTransport.test.ts`),
 * not a raw transport's, since `createNetifly()` always wraps a raw
 * transport in it before overlap can occur.
 */
export function runTransportContractTests(
  name: string,
  makeTransport: () => NetiflyTransport
): void {
  describe(`${name} transport contract`, () => {
    let transports: NetiflyTransport[];

    beforeEach(() => {
      transports = [];
    });

    afterEach(async () => {
      await Promise.all(transports.map((transport) => transport.close()));
    });

    function create(): NetiflyTransport {
      const transport = makeTransport();
      transports.push(transport);
      return transport;
    }

    it('delivers a published message to a subscribed transport', async () => {
      const subscriber = create();
      const publisher = create();
      const received: Array<{ userId: UserId; message: string }> = [];
      let resolveReceived: () => void;
      const receivedPromise = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      subscriber.onMessage((userId, message) => {
        received.push({ userId, message });
        resolveReceived();
      });

      await subscriber.subscribe('contract-alice');
      await publisher.publish('contract-alice', JSON.stringify({ hello: 'world' }));
      await receivedPromise;

      expect(received).toEqual([
        { userId: 'contract-alice', message: JSON.stringify({ hello: 'world' }) },
      ]);
    });

    it('does not deliver to a userId nobody has subscribed to', async () => {
      const publisher = create();
      const other = create();
      const onMessage = jest.fn();
      other.onMessage(onMessage);

      await publisher.publish('contract-nobody-home', JSON.stringify({ hello: 'world' }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', async () => {
      const subscriber = create();
      const publisher = create();
      const onMessage = jest.fn();
      subscriber.onMessage(onMessage);

      await subscriber.subscribe('contract-bob');
      await subscriber.unsubscribe('contract-bob');
      await publisher.publish('contract-bob', JSON.stringify({ hello: 'world' }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('publish() resolves with the current receiver count', async () => {
      const subscriber = create();
      const publisher = create();
      subscriber.onMessage(() => {});

      await expect(
        publisher.publish('contract-receivers', JSON.stringify({ a: 1 }))
      ).resolves.toEqual({ receivers: 0 });

      await subscriber.subscribe('contract-receivers');
      await expect(
        publisher.publish('contract-receivers', JSON.stringify({ a: 1 }))
      ).resolves.toEqual({ receivers: 1 });
    });

    it('receivers() reflects subscription state for every requested userId', async () => {
      const subscriber = create();
      const other = create();
      subscriber.onMessage(() => {});

      await subscriber.subscribe('contract-presence-a');
      await expect(
        other.receivers(['contract-presence-a', 'contract-presence-b'])
      ).resolves.toEqual({ 'contract-presence-a': 1, 'contract-presence-b': 0 });
    });

    it('receivers([]) resolves {} without erroring', async () => {
      const other = create();
      await expect(other.receivers([])).resolves.toEqual({});
    });

    it('close() on a transport that was never subscribed to anything does not throw', async () => {
      const transport = makeTransport(); // not pushed to `transports` — closed here directly
      await expect(transport.close()).resolves.toBeUndefined();
    });

    it('close() stops delivering to a previously subscribed transport', async () => {
      const subscriber = makeTransport(); // not pushed — closed explicitly below
      const publisher = create();
      const onMessage = jest.fn();
      subscriber.onMessage(onMessage);
      await subscriber.subscribe('contract-close');

      await subscriber.close();

      await publisher.publish('contract-close', JSON.stringify({ a: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });
  });
}
