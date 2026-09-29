import { NotificationValidationError, validateNotification } from './notification';
import type { ActionNotification, InfoNotification } from './types';

function baseInfo(overrides: Partial<InfoNotification> = {}): InfoNotification {
  return { kind: 'info', title: 'Export ready', body: 'Your report is ready.', ...overrides };
}

function baseAction(overrides: Partial<ActionNotification> = {}): ActionNotification {
  return {
    kind: 'action',
    title: 'Approve expense £420?',
    body: 'Submitted by Sam for Client dinner',
    actions: [{ id: 'approve', label: 'Approve' }],
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

describe('validateNotification: kind: info', () => {
  it('rejects a null notification', () => {
    expect(() => validateNotification(null as unknown as InfoNotification)).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an undefined notification', () => {
    expect(() => validateNotification(undefined as unknown as InfoNotification)).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a minimal valid notification', () => {
    expect(() => validateNotification(baseInfo())).not.toThrow();
  });

  it('rejects a missing kind', () => {
    const { kind: _kind, ...rest } = baseInfo();
    expect(() => validateNotification(rest as unknown as InfoNotification)).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an unrecognized kind', () => {
    expect(() =>
      validateNotification({ ...baseInfo(), kind: 'urgent' } as unknown as InfoNotification)
    ).toThrow(NotificationValidationError);
  });

  it('rejects an empty title', () => {
    expect(() => validateNotification(baseInfo({ title: '' }))).toThrow(NotificationValidationError);
  });

  it('rejects a whitespace-only title', () => {
    expect(() => validateNotification(baseInfo({ title: '   ' }))).toThrow(NotificationValidationError);
  });

  it('rejects a title over 120 characters', () => {
    expect(() => validateNotification(baseInfo({ title: 'x'.repeat(121) }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a title at exactly 120 characters', () => {
    expect(() => validateNotification(baseInfo({ title: 'x'.repeat(120) }))).not.toThrow();
  });

  it('rejects an empty body', () => {
    expect(() => validateNotification(baseInfo({ body: '' }))).toThrow(NotificationValidationError);
  });

  it('rejects a body over 500 characters', () => {
    expect(() => validateNotification(baseInfo({ body: 'x'.repeat(501) }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an invalid severity', () => {
    expect(() =>
      validateNotification(baseInfo({ severity: 'critical' as InfoNotification['severity'] }))
    ).toThrow(NotificationValidationError);
  });

  it.each(['info', 'success', 'warning', 'error'] as const)('accepts severity %s', (severity) => {
    expect(() => validateNotification(baseInfo({ severity }))).not.toThrow();
  });

  it('accepts a relative link href', () => {
    expect(() =>
      validateNotification(baseInfo({ link: { href: '/reports/123', label: 'Open' } }))
    ).not.toThrow();
  });

  it('accepts an https link href', () => {
    expect(() =>
      validateNotification(baseInfo({ link: { href: 'https://example.com/x', label: 'Open' } }))
    ).not.toThrow();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'vbscript:msgbox(1)',
    'not a url',
    '//evil.com/path',
    '///evil.com',
    '/\\evil.com',
    '/\\/evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
  ])('rejects an unsafe link href: %s', (href) => {
    expect(() =>
      validateNotification(baseInfo({ link: { href, label: 'Open' } }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects a null link (non-TS caller)', () => {
    expect(() =>
      validateNotification(baseInfo({ link: null as unknown as InfoNotification['link'] }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link.href that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseInfo({ link: { href: 123, label: 'Open' } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link with a missing label', () => {
    expect(() => validateNotification(baseInfo({ link: { href: '/x', label: '' } }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a link.label that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseInfo({ link: { href: '/x', label: 42 } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link label over 80 characters', () => {
    expect(() =>
      validateNotification(baseInfo({ link: { href: '/x', label: 'x'.repeat(81) } }))
    ).toThrow(NotificationValidationError);
  });

  it('accepts a valid icon', () => {
    expect(() => validateNotification(baseInfo({ icon: 'bell' }))).not.toThrow();
  });

  it('rejects a non-string icon', () => {
    expect(() =>
      validateNotification(baseInfo({ icon: 42 as unknown as string }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects an icon over 200 characters', () => {
    expect(() => validateNotification(baseInfo({ icon: 'x'.repeat(201) }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a valid expiresAt', () => {
    expect(() =>
      validateNotification(baseInfo({ expiresAt: Date.now() + 1000 }))
    ).not.toThrow();
  });

  it('rejects a non-number expiresAt', () => {
    expect(() =>
      validateNotification(baseInfo({ expiresAt: 'soon' as unknown as number }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects a NaN expiresAt', () => {
    expect(() => validateNotification(baseInfo({ expiresAt: NaN }))).toThrow(NotificationValidationError);
  });

  it('rejects an Infinity expiresAt', () => {
    expect(() => validateNotification(baseInfo({ expiresAt: Infinity }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a valid meta object', () => {
    expect(() => validateNotification(baseInfo({ meta: { orderId: 'abc123' } }))).not.toThrow();
  });

  it('rejects a null meta', () => {
    expect(() =>
      validateNotification(baseInfo({ meta: null as unknown as Record<string, unknown> }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects an array meta', () => {
    expect(() =>
      validateNotification(baseInfo({ meta: [1, 2, 3] as unknown as Record<string, unknown> }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects a primitive meta', () => {
    expect(() =>
      validateNotification(baseInfo({ meta: 'x' as unknown as Record<string, unknown> }))
    ).toThrow(NotificationValidationError);
  });
});

describe('validateNotification: kind: action', () => {
  it('accepts a minimal valid action notification', () => {
    expect(() => validateNotification(baseAction())).not.toThrow();
  });

  it('rejects an empty actions array', () => {
    expect(() => validateNotification(baseAction({ actions: [] }))).toThrow(NotificationValidationError);
  });

  it('rejects more than 5 actions', () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}` }));
    expect(() => validateNotification(baseAction({ actions }))).toThrow(NotificationValidationError);
  });

  it('accepts exactly 5 actions', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}` }));
    expect(() => validateNotification(baseAction({ actions }))).not.toThrow();
  });

  it('rejects duplicate action ids', () => {
    expect(() =>
      validateNotification(
        baseAction({
          actions: [
            { id: 'approve', label: 'Approve' },
            { id: 'approve', label: 'Approve Again' },
          ],
        })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects an action with an empty id', () => {
    expect(() =>
      validateNotification(baseAction({ actions: [{ id: '', label: 'Approve' }] }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects an action with an empty label', () => {
    expect(() =>
      validateNotification(baseAction({ actions: [{ id: 'approve', label: '' }] }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects an invalid action style', () => {
    expect(() =>
      validateNotification(
        baseAction({
          actions: [{ id: 'approve', label: 'Approve', style: 'huge' as unknown as 'primary' }],
        })
      )
    ).toThrow(NotificationValidationError);
  });

  it.each(['primary', 'danger', 'default'] as const)('accepts action style %s', (style) => {
    expect(() =>
      validateNotification(baseAction({ actions: [{ id: 'approve', label: 'Approve', style }] }))
    ).not.toThrow();
  });

  it('rejects a missing expiresAt', () => {
    const { expiresAt: _expiresAt, ...rest } = baseAction();
    expect(() => validateNotification(rest as unknown as ActionNotification)).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an expiresAt in the past', () => {
    expect(() => validateNotification(baseAction({ expiresAt: Date.now() - 1000 }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts an optional context object', () => {
    expect(() =>
      validateNotification(baseAction({ context: { expenseId: 'exp_123' } }))
    ).not.toThrow();
  });

  it('rejects a null meta (shared meta check applies to both kinds)', () => {
    expect(() =>
      validateNotification(baseAction({ meta: null as unknown as Record<string, unknown> }))
    ).toThrow(NotificationValidationError);
  });

  it('accepts a valid meta object', () => {
    expect(() => validateNotification(baseAction({ meta: { source: 'expenses' } }))).not.toThrow();
  });
});
