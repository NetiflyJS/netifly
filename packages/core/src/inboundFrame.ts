/** A validated client → server control frame (see NOT-30 spec §5). */
export type InboundFrame =
  | { type: 'ack'; id: string }
  | { type: 'read'; id: string }
  | { type: 'response'; id: string; payload: unknown };

export type InboundFrameParseFailureReason = 'invalidJson' | 'invalidShape';

export type ParsedInboundFrame =
  | { ok: true; frame: InboundFrame }
  | { ok: false; reason: InboundFrameParseFailureReason };

const ACK_OR_READ_TYPES = new Set(['ack', 'read']);

/**
 * Parses and validates one raw inbound WebSocket text frame into an
 * `InboundFrame`. Never throws — every failure is reported as
 * `{ ok: false, reason }` so the caller can count it via the
 * `'malformedFrame'` event instead of crashing the connection.
 */
export function parseInboundFrame(raw: string): ParsedInboundFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalidJson' };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalidShape' };
  }

  const { type, id } = value as { type?: unknown; id?: unknown };
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, reason: 'invalidShape' };
  }

  if (typeof type === 'string' && ACK_OR_READ_TYPES.has(type)) {
    return { ok: true, frame: { type: type as 'ack' | 'read', id } };
  }

  if (type === 'response') {
    if (!('payload' in value)) {
      return { ok: false, reason: 'invalidShape' };
    }
    return { ok: true, frame: { type: 'response', id, payload: (value as { payload: unknown }).payload } };
  }

  return { ok: false, reason: 'invalidShape' };
}
