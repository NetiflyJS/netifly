import { randomUUID } from 'node:crypto';
import type { NetiflyTransport, UserId } from '../types';

/**
 * The behavioral contract every `NetiflyTransport` implementation must
 * satisfy (NOT-20 design spec §10), run against both `redisTransport` and
 * `memoryTransport` from their own test files. Every test uses ONE
 * transport handle for both subscribing and publishing/checking
 * receivers — this matches how `createNetifly()` actually uses a
 * transport in production (always exactly one object), and is
 * satisfiable by both a shared-medium transport (Redis) and a genuinely
 * isolated, single-process one (memoryTransport) — it does not assume
 * two independently-constructed handles share any state. Ref-counted
 * overlapping subscribe()/unsubscribe() is deliberately NOT part of this
 * contract — that's RefCountedTransport's job (see
 * refCountedTransport.test.ts), not a raw transport's.
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
      const transport = create();
      const received: Array<{ userId: UserId; message: string }> = [];
      let resolveReceived: () => void;
      const receivedPromise = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      transport.onMessage((userId, message) => {
        received.push({ userId, message });
        resolveReceived();
      });

      await transport.subscribe('contract-alice');
      await transport.publish('contract-alice', JSON.stringify({ hello: 'world' }));
      await receivedPromise;

      expect(received).toEqual([
        { userId: 'contract-alice', message: JSON.stringify({ hello: 'world' }) },
      ]);
    });

    it('does not deliver to a userId nobody has subscribed to', async () => {
      const transport = create();
      const onMessage = jest.fn();
      transport.onMessage(onMessage);

      await transport.publish('contract-nobody-home', JSON.stringify({ hello: 'world' }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', async () => {
      const transport = create();
      const onMessage = jest.fn();
      transport.onMessage(onMessage);

      await transport.subscribe('contract-bob');
      await transport.unsubscribe('contract-bob');
      await transport.publish('contract-bob', JSON.stringify({ hello: 'world' }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('publish() resolves with the current receiver count', async () => {
      const transport = create();
      transport.onMessage(() => {});

      await expect(
        transport.publish('contract-receivers', JSON.stringify({ a: 1 }))
      ).resolves.toEqual({ receivers: 0 });

      await transport.subscribe('contract-receivers');
      await expect(
        transport.publish('contract-receivers', JSON.stringify({ a: 1 }))
      ).resolves.toEqual({ receivers: 1 });
    });

    it('receivers() reflects subscription state for every requested userId', async () => {
      const transport = create();
      transport.onMessage(() => {});

      await transport.subscribe('contract-presence-a');
      await expect(
        transport.receivers(['contract-presence-a', 'contract-presence-b'])
      ).resolves.toEqual({ 'contract-presence-a': 1, 'contract-presence-b': 0 });
    });

    it('receivers([]) resolves {} without erroring', async () => {
      const transport = create();
      await expect(transport.receivers([])).resolves.toEqual({});
    });

    it('claim(): the first caller wins and a later caller for the same key loses', async () => {
      const transport = create();
      // Unique per test run — claim() TTLs are real (up to 60s here) and
      // outlive the test process, so a fixed literal key would collide with
      // a still-live claim from a re-run of this same suite moments earlier
      // against a persistent Redis.
      const key = `contract-claim-1-${randomUUID()}`;
      const first = await transport.claim(key, 60);
      const second = await transport.claim(key, 60);
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('claim(): different keys do not contend with each other', async () => {
      const transport = create();
      const suffix = randomUUID();
      const a = await transport.claim(`contract-claim-a-${suffix}`, 60);
      const b = await transport.claim(`contract-claim-b-${suffix}`, 60);
      expect(a).toBe(true);
      expect(b).toBe(true);
    });

    it('close() on a transport that was never subscribed to anything does not throw', async () => {
      const transport = makeTransport(); // not pushed to `transports` — closed here directly
      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
}
