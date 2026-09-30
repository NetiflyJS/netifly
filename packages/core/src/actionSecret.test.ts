import { resolveActionSecret } from './actionSecret';

describe('resolveActionSecret', () => {
  const originalEnv = process.env.NETIFLY_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NETIFLY_SECRET;
    } else {
      process.env.NETIFLY_SECRET = originalEnv;
    }
  });

  it('returns the option value when a non-empty string is passed', () => {
    delete process.env.NETIFLY_SECRET;
    expect(resolveActionSecret('opt-secret')).toBe('opt-secret');
  });

  it('prefers the option value over NETIFLY_SECRET', () => {
    process.env.NETIFLY_SECRET = 'env-secret';
    expect(resolveActionSecret('opt-secret')).toBe('opt-secret');
  });

  it('falls back to NETIFLY_SECRET when the option is omitted', () => {
    process.env.NETIFLY_SECRET = 'env-secret';
    expect(resolveActionSecret(undefined)).toBe('env-secret');
  });

  it('returns undefined when explicitly disabled with actionSecret: false', () => {
    process.env.NETIFLY_SECRET = 'env-secret';
    expect(resolveActionSecret(false)).toBeUndefined();
  });

  it('throws when neither the option nor NETIFLY_SECRET is set', () => {
    delete process.env.NETIFLY_SECRET;
    expect(() => resolveActionSecret(undefined)).toThrow(
      'Netifly: no actionSecret provided and NETIFLY_SECRET is not set'
    );
  });

  it('throws when the option is an empty string and NETIFLY_SECRET is unset', () => {
    delete process.env.NETIFLY_SECRET;
    expect(() => resolveActionSecret('')).toThrow(
      'Netifly: no actionSecret provided and NETIFLY_SECRET is not set'
    );
  });
});
