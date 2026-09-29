import { NotificationValidationError, validateNotification } from './notification';
import type { InfoNotification } from './types';

function baseNotification(overrides: Partial<InfoNotification> = {}): InfoNotification {
  return { kind: 'info', title: 'Export ready', body: 'Your report is ready.', ...overrides };
}

describe('validateNotification', () => {
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
    expect(() => validateNotification(baseNotification())).not.toThrow();
  });

  it('rejects a missing kind', () => {
    const { kind: _kind, ...rest } = baseNotification();
    expect(() => validateNotification(rest as unknown as InfoNotification)).toThrow(
      NotificationValidationError
    );
  });

  it("rejects kind: 'action' (not supported by this version of notify())", () => {
    expect(() =>
      validateNotification({ ...baseNotification(), kind: 'action' } as unknown as InfoNotification)
    ).toThrow(NotificationValidationError);
  });

  it('rejects an empty title', () => {
    expect(() => validateNotification(baseNotification({ title: '' }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a whitespace-only title', () => {
    expect(() => validateNotification(baseNotification({ title: '   ' }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a title over 120 characters', () => {
    expect(() => validateNotification(baseNotification({ title: 'x'.repeat(121) }))).toThrow(
      NotificationValidationError
    );
  });

  it('accepts a title at exactly 120 characters', () => {
    expect(() => validateNotification(baseNotification({ title: 'x'.repeat(120) }))).not.toThrow();
  });

  it('rejects an empty body', () => {
    expect(() => validateNotification(baseNotification({ body: '' }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a body over 500 characters', () => {
    expect(() => validateNotification(baseNotification({ body: 'x'.repeat(501) }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects an invalid severity', () => {
    expect(() =>
      validateNotification(
        baseNotification({ severity: 'critical' as InfoNotification['severity'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it.each(['info', 'success', 'warning', 'error'] as const)('accepts severity %s', (severity) => {
    expect(() => validateNotification(baseNotification({ severity }))).not.toThrow();
  });

  it('accepts a relative link href', () => {
    expect(() =>
      validateNotification(baseNotification({ link: { href: '/reports/123', label: 'Open' } }))
    ).not.toThrow();
  });

  it('accepts an https link href', () => {
    expect(() =>
      validateNotification(
        baseNotification({ link: { href: 'https://example.com/x', label: 'Open' } })
      )
    ).not.toThrow();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'vbscript:msgbox(1)',
    'not a url',
    '//evil.com/path',
    '///evil.com'
  ])('rejects an unsafe link href: %s', (href) => {
    expect(() =>
      validateNotification(baseNotification({ link: { href, label: 'Open' } }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects a null link (non-TS caller)', () => {
    expect(() =>
      validateNotification(baseNotification({ link: null as unknown as InfoNotification['link'] }))
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link.href that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseNotification({ link: { href: 123, label: 'Open' } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link with a missing label', () => {
    expect(() => validateNotification(baseNotification({ link: { href: '/x', label: '' } }))).toThrow(
      NotificationValidationError
    );
  });

  it('rejects a link.label that is not a string (non-TS caller)', () => {
    expect(() =>
      validateNotification(
        baseNotification({ link: { href: '/x', label: 42 } as unknown as InfoNotification['link'] })
      )
    ).toThrow(NotificationValidationError);
  });

  it('rejects a link label over 80 characters', () => {
    expect(() =>
      validateNotification(baseNotification({ link: { href: '/x', label: 'x'.repeat(81) } }))
    ).toThrow(NotificationValidationError);
  });
});
