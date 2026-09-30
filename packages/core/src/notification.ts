import type { Notification } from './types';

/** Thrown by `validateNotification()` — exported so apps can `instanceof`-check it apart from other errors a `notify()` call might reject with. */
export class NotificationValidationError extends Error {}

export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 500;
export const MAX_LINK_LABEL_LENGTH = 80;
export const MAX_ACTIONS = 5;
export const MAX_ICON_LENGTH = 200;
const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const ACTION_STYLES = new Set(['primary', 'danger', 'default']);

const SAFE_LINK_BASE = 'https://netifly.invalid';

function isSafeLinkHref(href: string): boolean {
  // A relative href must still resolve to the base origin — this is what
  // rejects //host, /\host, and the tab/newline variants the URL parser
  // strips before parsing.
  if (href.startsWith('/')) {
    try {
      return new URL(href, SAFE_LINK_BASE).origin === SAFE_LINK_BASE;
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateTitleAndBody(notification: Notification): void {
  const title = (notification as { title?: unknown }).title;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new NotificationValidationError(
      `Netifly: notify() requires a non-empty title of at most ${MAX_TITLE_LENGTH} characters`
    );
  }

  const body = (notification as { body?: unknown }).body;
  if (typeof body !== 'string' || body.trim().length === 0 || body.length > MAX_BODY_LENGTH) {
    throw new NotificationValidationError(
      `Netifly: notify() requires a non-empty body of at most ${MAX_BODY_LENGTH} characters`
    );
  }
}

function validateMeta(notification: Notification): void {
  const meta = (notification as { meta?: unknown }).meta;
  if (meta === undefined) {
    return;
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new NotificationValidationError(
      `Netifly: notify() meta must be a plain object, got ${JSON.stringify(meta)}`
    );
  }
}

function validateInfoOnlyFields(notification: Notification): void {
  const severity = (notification as { severity?: unknown }).severity;
  if (severity !== undefined && !SEVERITIES.has(severity as string)) {
    throw new NotificationValidationError(
      `Netifly: notify() severity must be one of 'info' | 'success' | 'warning' | 'error', got ${JSON.stringify(severity)}`
    );
  }

  const link = (notification as { link?: unknown }).link;
  if (link !== undefined) {
    if (link === null || typeof link !== 'object') {
      throw new NotificationValidationError(
        `Netifly: notify() link must be an object, got ${JSON.stringify(link)}`
      );
    }
    const href = (link as { href?: unknown }).href;
    const label = (link as { label?: unknown }).label;

    if (typeof href !== 'string' || !isSafeLinkHref(href)) {
      throw new NotificationValidationError(
        `Netifly: notify() link.href must be a relative path or an http(s) URL, got ${JSON.stringify(href)}`
      );
    }
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_LINK_LABEL_LENGTH) {
      throw new NotificationValidationError(
        `Netifly: notify() link.label is required and must be at most ${MAX_LINK_LABEL_LENGTH} characters`
      );
    }
  }

  const icon = (notification as { icon?: unknown }).icon;
  if (icon !== undefined) {
    if (typeof icon !== 'string' || icon.length > MAX_ICON_LENGTH) {
      throw new NotificationValidationError(
        `Netifly: notify() icon must be a string of at most ${MAX_ICON_LENGTH} characters`
      );
    }
  }

  const expiresAt = (notification as { expiresAt?: unknown }).expiresAt;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      throw new NotificationValidationError(
        `Netifly: notify() expiresAt must be a finite number, got ${JSON.stringify(expiresAt)}`
      );
    }
  }
}

function validateActions(notification: Notification): void {
  const actions = (notification as { actions?: unknown }).actions;
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_ACTIONS) {
    throw new NotificationValidationError(
      `Netifly: notify() kind:'action' requires a non-empty actions array of at most ${MAX_ACTIONS} entries`
    );
  }

  const seenIds = new Set<string>();
  for (const action of actions) {
    const id = (action as { id?: unknown }).id;
    const label = (action as { label?: unknown }).label;
    const style = (action as { style?: unknown }).style;

    if (typeof id !== 'string' || id.length === 0) {
      throw new NotificationValidationError('Netifly: notify() every action requires a non-empty id');
    }
    if (seenIds.has(id)) {
      throw new NotificationValidationError(`Netifly: notify() action ids must be unique, duplicate "${id}"`);
    }
    seenIds.add(id);

    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new NotificationValidationError('Netifly: notify() every action requires a non-empty label');
    }
    if (style !== undefined && !ACTION_STYLES.has(style as string)) {
      throw new NotificationValidationError(
        `Netifly: notify() action.style must be one of 'primary' | 'danger' | 'default', got ${JSON.stringify(style)}`
      );
    }
  }

  const expiresAt = (notification as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new NotificationValidationError(
      "Netifly: notify() kind:'action' requires expiresAt to be a timestamp in the future"
    );
  }
}

/**
 * Validates a `notify()`/`notifyOr()` argument before anything is built or
 * published. Every check reads fields via an `unknown`-typed cast rather
 * than trusting the declared `Notification` type, since this also has to
 * defend plain-JS callers who bypass TypeScript entirely. Throws
 * `NotificationValidationError` on the first failure.
 */
export function validateNotification(notification: Notification): void {
  if (notification === null || typeof notification !== 'object') {
    throw new NotificationValidationError('Netifly: notify() requires a notification object');
  }

  const kind = (notification as { kind?: unknown }).kind;
  if (kind !== 'info' && kind !== 'action') {
    throw new NotificationValidationError(
      `Netifly: notify() requires kind: 'info' | 'action', got ${JSON.stringify(kind)}`
    );
  }

  validateTitleAndBody(notification);
  validateMeta(notification);

  if (kind === 'info') {
    validateInfoOnlyFields(notification);
    return;
  }

  validateActions(notification);
}
