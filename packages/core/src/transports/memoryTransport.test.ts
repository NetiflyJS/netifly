import { memoryTransport } from './memoryTransport';
import { runTransportContractTests } from './transport.contract';

runTransportContractTests('memoryTransport', () => memoryTransport());

describe('memoryTransport', () => {
  it('delivers asynchronously, not synchronously within publish()', async () => {
    const transport = memoryTransport();
    const onMessage = jest.fn();
    transport.onMessage(onMessage);
    await transport.subscribe('memory-async');

    void transport.publish('memory-async', JSON.stringify({ a: 1 }));
    expect(onMessage).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).toHaveBeenCalledWith('memory-async', JSON.stringify({ a: 1 }));

    await transport.close();
  });

  it('receivers() only ever reports 0 or 1 — this transport models exactly one process', async () => {
    const transport = memoryTransport();
    await transport.subscribe('memory-solo');
    await transport.subscribe('memory-solo'); // subscribing twice is not this transport's concern (ref-counting lives above it)

    await expect(transport.receivers(['memory-solo'])).resolves.toEqual({ 'memory-solo': 1 });

    await transport.close();
  });

  it('claim() releases the key once ttlSeconds has elapsed', async () => {
    const transport = memoryTransport();

    const first = await transport.claim('memory-claim-ttl', 1);
    expect(first).toBe(true);

    const immediateRetry = await transport.claim('memory-claim-ttl', 1);
    expect(immediateRetry).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterExpiry = await transport.claim('memory-claim-ttl', 1);
    expect(afterExpiry).toBe(true);

    await transport.close();
  });
});
