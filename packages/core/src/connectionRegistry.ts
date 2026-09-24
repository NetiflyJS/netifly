export type UserId = string;

export interface ConnectionRegistryOptions {
  onFirstConnection?: (userId: UserId) => void;
  onLastDisconnect?: (userId: UserId) => void;
}

export class ConnectionRegistry<TConnection> {
  private readonly connections = new Map<UserId, Set<TConnection>>();
  private readonly onFirstConnection: (userId: UserId) => void;
  private readonly onLastDisconnect: (userId: UserId) => void;

  constructor(options: ConnectionRegistryOptions) {
    this.onFirstConnection = options.onFirstConnection ?? (() => {});
    this.onLastDisconnect = options.onLastDisconnect ?? (() => {});
  }

  add(userId: UserId, connection: TConnection): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(connection);
    if (wasEmpty) {
      this.onFirstConnection(userId);
    }
  }

  remove(userId: UserId, connection: TConnection): void {
    const set = this.connections.get(userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(userId);
      this.onLastDisconnect(userId);
    }
  }

  getConnections(userId: UserId): ReadonlySet<TConnection> {
    return this.connections.get(userId) ?? new Set<TConnection>();
  }

  hasConnections(userId: UserId): boolean {
    return this.connections.has(userId);
  }

  clear(): void {
    this.connections.clear();
  }
}
