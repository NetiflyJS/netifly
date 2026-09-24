import { ConnectionRegistry } from './connectionRegistry';

describe('ConnectionRegistry', () => {
  it('calls onFirstConnection when the first connection for a user is added', () => {
    const onFirstConnection = jest.fn();
    const registry = new ConnectionRegistry<string>({ onFirstConnection });

    registry.add('alice', 'conn-1');

    expect(onFirstConnection).toHaveBeenCalledWith('alice');
    expect(onFirstConnection).toHaveBeenCalledTimes(1);
  });

  it('does not call onFirstConnection again for a second connection from the same user', () => {
    const onFirstConnection = jest.fn();
    const registry = new ConnectionRegistry<string>({ onFirstConnection });

    registry.add('alice', 'conn-1');
    registry.add('alice', 'conn-2');

    expect(onFirstConnection).toHaveBeenCalledTimes(1);
  });

  it('does not call onLastDisconnect when one of two connections is removed', () => {
    const onLastDisconnect = jest.fn();
    const registry = new ConnectionRegistry<string>({ onLastDisconnect });

    registry.add('alice', 'conn-1');
    registry.add('alice', 'conn-2');
    registry.remove('alice', 'conn-1');

    expect(onLastDisconnect).not.toHaveBeenCalled();
    expect(registry.hasConnections('alice')).toBe(true);
  });

  it('calls onLastDisconnect when the last connection for a user is removed', () => {
    const onLastDisconnect = jest.fn();
    const registry = new ConnectionRegistry<string>({ onLastDisconnect });

    registry.add('alice', 'conn-1');
    registry.remove('alice', 'conn-1');

    expect(onLastDisconnect).toHaveBeenCalledWith('alice');
    expect(registry.hasConnections('alice')).toBe(false);
  });

  it('is a safe no-op when removing a connection for an unknown user', () => {
    const registry = new ConnectionRegistry<string>({});

    expect(() => registry.remove('nobody', 'conn-1')).not.toThrow();
  });

  it('returns the exact set of connections for a user', () => {
    const registry = new ConnectionRegistry<string>({});
    registry.add('bob', 'conn-1');
    registry.add('bob', 'conn-2');

    expect(registry.getConnections('bob')).toEqual(new Set(['conn-1', 'conn-2']));
    expect(registry.getConnections('unknown')).toEqual(new Set());
  });

  it('clear() removes all tracked connections', () => {
    const registry = new ConnectionRegistry<string>({});
    registry.add('bob', 'conn-1');

    registry.clear();

    expect(registry.hasConnections('bob')).toBe(false);
  });
});
