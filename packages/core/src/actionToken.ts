import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActionNotification, UserId, WireNotification } from './types';

/** The payload signed into every action token — see NOT-38 spec §6. */
export interface ActionTokenPayload {
  nid: string;
  uid: UserId;
  aid: string;
  exp: number;
  ctx: Record<string, unknown> | null;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('hex');
}

export function signActionToken(payload: ActionTokenPayload, secret: string): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export type VerifyActionTokenResult =
  | { ok: true; payload: ActionTokenPayload }
  | { ok: false; reason: 'invalid' };

/**
 * Verifies a token produced by signActionToken(): recomputes the HMAC over
 * the encoded payload and compares it (timing-safe) against the signature,
 * then structurally validates the decoded payload. Never throws — every
 * failure mode (malformed token, bad signature, undecodable/malshaped
 * payload) comes back as `{ ok: false, reason: 'invalid' }`.
 */
export function verifyActionToken(token: string, secret: string): VerifyActionTokenResult {
  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return { ok: false, reason: 'invalid' };
  }

  const encoded = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expected = sign(encoded, secret);

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, reason: 'invalid' };
  }

  let payload: ActionTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as ActionTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.nid !== 'string' ||
    typeof payload.uid !== 'string' ||
    typeof payload.aid !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, payload };
}

/**
 * Builds what actually goes on the wire for a kind:'action' notification:
 * each action gets a signed token embedding
 * notificationId/userId/actionId/expiresAt/context, and `context` itself is
 * never a plain top-level field (see NOT-38 spec §6).
 */
export function buildActionWireNotification(
  notification: ActionNotification,
  params: { notificationId: string; userId: UserId; secret: string }
): WireNotification {
  const wireActions = notification.actions.map((action) => ({
    ...action,
    token: signActionToken(
      {
        nid: params.notificationId,
        uid: params.userId,
        aid: action.id,
        exp: notification.expiresAt,
        ctx: notification.context ?? null,
      },
      params.secret
    ),
  }));

  return {
    kind: 'action',
    title: notification.title,
    body: notification.body,
    actions: wireActions,
    expiresAt: notification.expiresAt,
    ...(notification.meta !== undefined ? { meta: notification.meta } : {}),
  };
}
