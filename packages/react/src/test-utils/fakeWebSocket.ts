/**
 * A minimal `WebSocket` double covering exactly the surface `NetiflyClient`
 * touches (constructor, `addEventListener`, `send`, `close`, `readyState`,
 * `protocol`) plus test-side helpers to drive it and inspect what was sent.
 * jsdom ships no `WebSocket` at all, and no fake exists elsewhere in this
 * repo — `@netiflyjs/client`'s own tests run against a real server instead.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static latest(): FakeWebSocket {
    const instance = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!instance) throw new Error('FakeWebSocket: no instance has been constructed yet');
    return instance;
  }

  readonly url: string;
  readonly requestedProtocols: string[];
  readyState = FakeWebSocket.CONNECTING;
  protocol = '';
  readonly sentFrames: unknown[] = [];
  /**
   * True as soon as `close()` is called, independent of `readyState`'s own
   * (synchronous, simplified) transition — real close() is asynchronous
   * (CLOSING, then CLOSED later), so a test asserting "exactly one socket
   * is still live" must not do it by reading `readyState` at an arbitrary
   * later point, which only works if close() happens to resolve
   * synchronously here. This flag is true the instant close() is asked
   * for, which is true under either timing model.
   */
  closeRequested = false;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.requestedProtocols = protocols === undefined ? [] : [protocols].flat();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new Error('FakeWebSocket: send() called before the socket is open');
    }
    if (this.readyState !== FakeWebSocket.OPEN) {
      return;
    }
    this.sentFrames.push(JSON.parse(data));
  }

  close(code = 1000, reason = ''): void {
    this.closeRequested = true;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', { code, reason, wasClean: code === 1000 });
  }

  /** Test-side: completes the handshake. */
  simulateOpen(protocol = ''): void {
    this.readyState = FakeWebSocket.OPEN;
    this.protocol = protocol;
    this.dispatch('open', {});
  }

  /** Test-side: delivers a server frame. */
  simulateMessage(data: unknown): void {
    this.dispatch('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  /** Test-side: the server closed the connection. */
  simulateServerClose(code: number, reason = '', wasClean = true): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', { code, reason, wasClean });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}
