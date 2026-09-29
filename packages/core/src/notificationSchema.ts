import { MAX_TITLE_LENGTH, MAX_BODY_LENGTH, MAX_LINK_LABEL_LENGTH } from './notification';

/**
 * A hand-written JSON Schema (draft-07) mirroring `InfoNotification` in
 * types.ts and the runtime checks in notification.ts — kept in sync by hand,
 * since the shape is small and stable. Exported as a plain object (rather
 * than a .json file) so it ships through the normal `tsc` build into
 * `dist/`, matching how every other export in this package is built.
 *
 * `additionalProperties` is deliberately omitted at the top level: the
 * runtime validator in notification.ts ignores unknown properties, so a
 * schema that rejected them would be stricter than what the server actually
 * accepts.
 */
export const notificationJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'NetiflyInfoNotification',
  type: 'object',
  properties: {
    kind: { const: 'info' },
    // minLength: 1 accepts whitespace-only strings (e.g. "   "), which the
    // runtime validator in notification.ts additionally rejects via a
    // `.trim()` check. JSON Schema draft-07 can't easily express "non-
    // whitespace", so this schema is intentionally looser than the runtime
    // here — the runtime validator remains the source of truth.
    title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
    // Same whitespace-only caveat as `title` above.
    body: { type: 'string', minLength: 1, maxLength: MAX_BODY_LENGTH },
    severity: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
    link: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Restricts href to a relative path (single leading `/`, not `//`)
        // or an http(s) URL — blocks the obvious unsafe schemes
        // (javascript:, data:, vbscript:, ...) and bare `//host` protocol-
        // relative URLs. This can't express the full origin-resolution
        // check `isSafeLinkHref()` performs at runtime (e.g. `/\host`
        // variants), so the runtime validator remains the authoritative
        // check — this pattern is a best-effort schema-level backstop.
        href: { type: 'string', minLength: 1, pattern: '^(\\/(?!\\/)|https?:\\/\\/)' },
        label: { type: 'string', minLength: 1, maxLength: MAX_LINK_LABEL_LENGTH },
      },
      required: ['href', 'label'],
    },
    icon: { type: 'string' },
    expiresAt: { type: 'number' },
    meta: { type: 'object' },
  },
  required: ['kind', 'title', 'body'],
} as const;
