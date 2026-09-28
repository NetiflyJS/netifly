import { parseInboundFrame } from './inboundFrame';

describe('parseInboundFrame', () => {
  it('parses a valid ack frame', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'ack', id: 'notif-1' }));
    expect(result).toEqual({ ok: true, frame: { type: 'ack', id: 'notif-1' } });
  });

  it('parses a valid read frame', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'read', id: 'notif-2' }));
    expect(result).toEqual({ ok: true, frame: { type: 'read', id: 'notif-2' } });
  });

  it('parses a valid response frame with an object payload', () => {
    const result = parseInboundFrame(
      JSON.stringify({ type: 'response', id: 'notif-3', payload: { choice: 'accept' } })
    );
    expect(result).toEqual({
      ok: true,
      frame: { type: 'response', id: 'notif-3', payload: { choice: 'accept' } },
    });
  });

  it('accepts a response frame with a null payload', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'response', id: 'notif-4', payload: null }));
    expect(result).toEqual({ ok: true, frame: { type: 'response', id: 'notif-4', payload: null } });
  });

  it('accepts a response frame with a primitive payload', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'response', id: 'notif-5', payload: 42 }));
    expect(result).toEqual({ ok: true, frame: { type: 'response', id: 'notif-5', payload: 42 } });
  });

  it('rejects invalid JSON', () => {
    expect(parseInboundFrame('not json')).toEqual({ ok: false, reason: 'invalidJson' });
  });

  it('rejects a JSON array', () => {
    expect(parseInboundFrame('[1,2,3]')).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects JSON null', () => {
    expect(parseInboundFrame('null')).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects a missing type', () => {
    expect(parseInboundFrame(JSON.stringify({ id: 'x' }))).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects an unknown type value', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'delete', id: 'x' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects a missing id', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'ack' }))).toEqual({ ok: false, reason: 'invalidShape' });
  });

  it('rejects a non-string id', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'ack', id: 42 }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects an empty-string id', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'ack', id: '' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });

  it('rejects a response frame missing the payload key', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'response', id: 'x' }))).toEqual({
      ok: false,
      reason: 'invalidShape',
    });
  });
});
