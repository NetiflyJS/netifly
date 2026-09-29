import { buildActionWireNotification, signActionToken, verifyActionToken } from './actionToken';
import type { ActionNotification } from './types';

const SECRET = 'test-secret';

function basePayload() {
  return { nid: 'notif-1', uid: 'user-1', aid: 'approve', exp: Date.now() + 60_000, ctx: null };
}

describe('signActionToken / verifyActionToken', () => {
  it('round-trips a payload signed and verified with the same secret', () => {
    const payload = basePayload();
    const token = signActionToken(payload, SECRET);
    expect(verifyActionToken(token, SECRET)).toEqual({ ok: true, payload });
  });

  it('round-trips a non-null context object', () => {
    const payload = { ...basePayload(), ctx: { expenseId: 'exp_123' } };
    const token = signActionToken(payload, SECRET);
    expect(verifyActionToken(token, SECRET)).toEqual({ ok: true, payload });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signActionToken(basePayload(), SECRET);
    expect(verifyActionToken(token, 'wrong-secret')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with a tampered payload segment', () => {
    const token = signActionToken(basePayload(), SECRET);
    const [encoded, signature] = token.split('.');
    expect(verifyActionToken(`${encoded}x.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a token with a tampered signature segment', () => {
    const token = signActionToken(basePayload(), SECRET);
    const [encoded, signature] = token.split('.');
    const flipped = signature[0] === 'a' ? `b${signature.slice(1)}` : `a${signature.slice(1)}`;
    expect(verifyActionToken(`${encoded}.${flipped}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a token with no separator', () => {
    expect(verifyActionToken('not-a-real-token', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with an empty payload segment', () => {
    expect(verifyActionToken('.somesignature', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with an empty signature segment', () => {
    const token = signActionToken(basePayload(), SECRET);
    const [encoded] = token.split('.');
    expect(verifyActionToken(`${encoded}.`, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('buildActionWireNotification', () => {
  function actionNotification(overrides: Partial<ActionNotification> = {}): ActionNotification {
    return {
      kind: 'action',
      title: 'Approve expense £420?',
      body: 'Submitted by Sam for Client dinner',
      actions: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
      expiresAt: Date.now() + 3600_000,
      context: { expenseId: 'exp_123' },
      ...overrides,
    };
  }

  it('embeds a signed token per action and strips context from the wire payload', () => {
    const notification = actionNotification();
    const wire = buildActionWireNotification(notification, {
      notificationId: 'notif-1',
      userId: 'user-1',
      secret: SECRET,
    });

    expect(wire.kind).toBe('action');
    expect('context' in wire).toBe(false);
    expect(wire).toMatchObject({
      title: notification.title,
      body: notification.body,
      expiresAt: notification.expiresAt,
    });

    const wireActions = (wire as { actions: { id: string; token: string }[] }).actions;
    expect(wireActions).toHaveLength(2);
    for (const action of wireActions) {
      expect(verifyActionToken(action.token, SECRET)).toEqual({
        ok: true,
        payload: {
          nid: 'notif-1',
          uid: 'user-1',
          aid: action.id,
          exp: notification.expiresAt,
          ctx: { expenseId: 'exp_123' },
        },
      });
    }
  });

  it('signs ctx: null when the notification has no context', () => {
    const notification = actionNotification({ context: undefined });
    const wire = buildActionWireNotification(notification, {
      notificationId: 'notif-2',
      userId: 'user-1',
      secret: SECRET,
    });
    const [firstAction] = (wire as { actions: { token: string }[] }).actions;
    const verified = verifyActionToken(firstAction.token, SECRET);
    expect(verified.ok && verified.payload.ctx).toBe(null);
  });

  it('omits meta from the wire payload when not provided', () => {
    const wire = buildActionWireNotification(actionNotification(), {
      notificationId: 'notif-3',
      userId: 'user-1',
      secret: SECRET,
    });
    expect('meta' in wire).toBe(false);
  });

  it('includes meta on the wire payload when provided', () => {
    const wire = buildActionWireNotification(actionNotification({ meta: { source: 'expenses' } }), {
      notificationId: 'notif-4',
      userId: 'user-1',
      secret: SECRET,
    });
    expect((wire as { meta?: unknown }).meta).toEqual({ source: 'expenses' });
  });
});
