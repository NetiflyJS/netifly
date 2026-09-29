import { NotificationValidationError, validateNotification } from './notification';
import { notificationJsonSchema } from './notificationSchema';
import type { InfoNotification } from './types';

/**
 * A minimal, hand-rolled check against `notificationJsonSchema`'s
 * `required`/`maxLength`/`enum` constraints — not a full JSON Schema
 * validator, just enough to exercise the specific fields this test cares
 * about (title/body length and presence, severity enum membership, required
 * fields) so this suite can assert the schema and the runtime validator
 * agree on accept/reject for the same inputs.
 */
function checkAgainstSchema(notification: Record<string, unknown>): boolean {
  for (const field of notificationJsonSchema.required) {
    if (!(field in notification)) {
      return false;
    }
  }

  const title = notification.title;
  const titleSchema = notificationJsonSchema.properties.title;
  if (
    typeof title !== 'string' ||
    title.length < titleSchema.minLength ||
    title.length > titleSchema.maxLength
  ) {
    return false;
  }

  const body = notification.body;
  const bodySchema = notificationJsonSchema.properties.body;
  if (
    typeof body !== 'string' ||
    body.length < bodySchema.minLength ||
    body.length > bodySchema.maxLength
  ) {
    return false;
  }

  if ('severity' in notification && notification.severity !== undefined) {
    const allowed: readonly string[] = notificationJsonSchema.properties.severity.enum;
    if (!allowed.includes(notification.severity as string)) {
      return false;
    }
  }

  return true;
}

function runtimeAccepts(notification: unknown): boolean {
  try {
    validateNotification(notification as InfoNotification);
    return true;
  } catch (error) {
    if (error instanceof NotificationValidationError) {
      return false;
    }
    throw error;
  }
}

describe('notificationJsonSchema vs. validateNotification() agreement', () => {
  const fixtures: Array<{ name: string; notification: Record<string, unknown>; expectAccept: boolean }> = [
    {
      name: 'a valid minimal notification',
      notification: { kind: 'info', title: 'Export ready', body: 'Your report is ready.' },
      expectAccept: true,
    },
    {
      name: 'a title over 120 chars',
      notification: { kind: 'info', title: 'x'.repeat(121), body: 'Your report is ready.' },
      expectAccept: false,
    },
    {
      name: 'an invalid severity',
      notification: {
        kind: 'info',
        title: 'Export ready',
        body: 'Your report is ready.',
        severity: 'critical',
      },
      expectAccept: false,
    },
    {
      name: 'a notification with an extra unknown property',
      notification: {
        kind: 'info',
        title: 'Export ready',
        body: 'Your report is ready.',
        somethingUnknown: true,
      },
      expectAccept: true,
    },
  ];

  it.each(fixtures)('$name: schema and runtime agree', ({ notification, expectAccept }) => {
    expect(checkAgainstSchema(notification)).toBe(expectAccept);
    expect(runtimeAccepts(notification)).toBe(expectAccept);
  });
});
