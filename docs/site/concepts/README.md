# Concepts

[Getting started](../getting-started.md) gets you to a working `send()`.
[Recipes](../recipes/README.md) solve one specific problem each. This
section is the layer in between — the mental model that makes the rest of
the docs predictable instead of a pile of unrelated snippets.

- **[Hooks: backend and frontend](hooks.md)** — every lifecycle event
  Netifly emits, on both sides of the wire, as one picture instead of
  scattered reference entries.
- **[Publishing patterns: single, multiple, two-way](publishing-patterns.md)**
  — notifying one user, fanning out to many, and letting a user answer
  back.
- **[Persistence](persistence.md)** — Netifly stores nothing. What that
  actually means for building a notification inbox, and where the real
  gaps are today.

## The three-sentence model

Netifly routes by **user**, not by room or channel: `send(userId, ...)`
reaches every connection that user holds, anywhere in your cluster, or
nothing if they're offline. Delivery is **at-most-once and
fire-and-forget** — a successful `send()`/`notify()` means a server
process held a live socket for that user at that instant, not that
anything was durably queued for later. Everything past that single hop —
history, persistence, "did they actually read it" — is **your
application's job**, using the hooks in [Hooks](hooks.md) and the pattern
in [Persistence](persistence.md); Netifly stays storage-agnostic on
purpose, the same way `resolveUserId` keeps it auth-agnostic.
