import { TextDecoder, TextEncoder } from 'node:util';
import { FakeWebSocket } from './src/test-utils/fakeWebSocket';

// jsdom doesn't provide these, but react-dom/server's bundle references them
// even for synchronous renderToString() — needed only so the SSR test can
// import 'react-dom/server' at all.
(globalThis as { TextEncoder?: unknown }).TextEncoder ??= TextEncoder;
(globalThis as { TextDecoder?: unknown }).TextDecoder ??= TextDecoder;

(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
