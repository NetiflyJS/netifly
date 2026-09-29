import type { Notification } from './types';

/** Thrown by `validateNotification()` — exported so apps can `instanceof`-check it apart from other errors a `notify()` call might reject with. */
export class NotificationValidationError extends Error {}

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_LINK_LABEL_LENGTH = 80;
const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);

function isSafeLinkHref(href: string): boolean {
  // Reject protocol-relative URLs (//host/path), which browsers resolve as absolute cross-origin URLs
  if (href.startsWith('//')) {
    return false;
  }
  // Accept relative paths starting with exactly one /
  if (href.startsWith('/')) {
    return true;
  }
  // Accept http(s) URLs
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates a `notify()`/`notifyOr()` argument before anything is built or
 * published. Every check reads fields via an `unknown`-typed cast rather
 * than trusting the declared `Notification` type, since this also has to
 * defend plain-JS callers who bypass TypeScript entirely (see the plan's
 * Review Focus). Throws `NotificationValidationError` on the first failure.
 */
export function validateNotification(notification: Notification): void {
  if (notification === null || typeof notification !== 'object') {
    throw new NotificationValidationError('Netifly: notify() requires a notification object');
  }

  const kind = (notification as { kind?: unknown }).kind;
  if (kind !== 'info') {
    throw new NotificationValidationError(
      `Netifly: notify() requires kind: 'info' in this version, got ${JSON.stringify(kind)}`
    );
  }

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

  const severity = notification.severity;
  if (severity !== undefined && !SEVERITIES.has(severity)) {
    throw new NotificationValidationError(
      `Netifly: notify() severity must be one of 'info' | 'success' | 'warning' | 'error', got ${JSON.stringify(severity)}`
    );
  }

  if (notification.link !== undefined) {
    if (notification.link === null || typeof notification.link !== 'object') {
      throw new NotificationValidationError(
        `Netifly: notify() link must be an object, got ${JSON.stringify(notification.link)}`
      );
    }

    const href = (notification.link as { href?: unknown }).href;
    const label = (notification.link as { label?: unknown }).label;

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
}
