/**
 * Resolves the HMAC secret used to sign/verify kind:'action' notification
 * tokens. `optionValue === false` means the caller explicitly disabled
 * actions for this server/publisher — returns `undefined` in that case
 * (meaning "actions disabled," not "unset"). Any other missing value
 * (option omitted and NETIFLY_SECRET unset) is a configuration error and
 * throws at construction time — see the NOT-38 spec §6 for why this is
 * validated eagerly rather than lazily on first use.
 */
export function resolveActionSecret(optionValue: string | false | undefined): string | undefined {
  if (optionValue === false) {
    return undefined;
  }
  if (typeof optionValue === 'string' && optionValue.length > 0) {
    return optionValue;
  }
  const fromEnv = process.env.NETIFLY_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new Error(
    "Netifly: no actionSecret provided and NETIFLY_SECRET is not set. Pass { actionSecret } or set NETIFLY_SECRET — or pass { actionSecret: false } to disable kind:'action' notifications for this server."
  );
}
