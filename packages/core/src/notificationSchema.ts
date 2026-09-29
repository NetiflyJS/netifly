/**
 * A hand-written JSON Schema (draft-07) mirroring `InfoNotification` in
 * types.ts and the runtime checks in notification.ts — kept in sync by hand,
 * since the shape is small and stable. Exported as a plain object (rather
 * than a .json file) so it ships through the normal `tsc` build into
 * `dist/`, matching how every other export in this package is built.
 */
export const notificationJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'NetiflyInfoNotification',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { const: 'info' },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    body: { type: 'string', minLength: 1, maxLength: 500 },
    severity: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
    link: {
      type: 'object',
      additionalProperties: false,
      properties: {
        href: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1, maxLength: 80 },
      },
      required: ['href', 'label'],
    },
    icon: { type: 'string' },
    expiresAt: { type: 'number' },
    meta: { type: 'object' },
  },
  required: ['kind', 'title', 'body'],
} as const;
