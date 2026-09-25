# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project overview

Netifly (npm scope `@netiflyjs`) is a pnpm workspace monorepo providing framework-agnostic,
real-time per-user notifications for Node.js servers (WebSockets + Redis pub/sub).

- `packages/core` — `@netiflyjs/core`, the framework-agnostic engine.
- `packages/express` — `@netiflyjs/express`, a thin Express adapter over `core`.

## Setup

```bash
pnpm install
docker run --rm -p 6379:6379 redis:7-alpine   # tests need a local Redis
```

## Common commands

Run from the repo root (they fan out to all packages via `pnpm -r`):

```bash
pnpm build       # tsc build for every package
pnpm test        # jest for every package (needs Redis at REDIS_URL, default redis://127.0.0.1:6379)
pnpm lint         # eslint . --ext .ts
pnpm typecheck    # tsc --noEmit for every package
```

Run a single package's tests from its directory, e.g. `cd packages/core && pnpm test`.

Always run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before considering a change done —
CI (`.github/workflows/ci.yml`) runs all three plus `pnpm build` on Node 18 and 20.

## Branching

**Name branches after the ticket, not the change.** Tickets live in Linear under the `NOT`
project prefix (e.g. `NOT-42`). Branch names are the ticket id, optionally with a short
kebab-case slug appended:

```
NOT-42
NOT-11-readme-security-section
```

Do not invent free-form branch names (`fix-bug`, `feature/x`) when a ticket exists — use its
id. If no ticket exists for the work, ask for one rather than guessing a name.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`chore:`, `docs:`, `ci:`, etc.). `semantic-release` parses these on merge to `main` to version
and publish each package independently — don't hand-edit `CHANGELOG.md` or package versions.

## Code style

- TypeScript throughout, strict-ish via `tsconfig.base.json`.
- Formatting via Prettier (`.prettierrc.json`: single quotes, semicolons, trailing commas,
  100-char width) and `eslint:recommended` + `@typescript-eslint/recommended`
  (`.eslintrc.cjs`). Run `pnpm lint` rather than hand-formatting.
- Tests are colocated with source as `*.test.ts` and run with Jest (`ts-jest`).

## Things to know

- Never hardcode a Redis connection string or default to `localhost` — `redisUrl` /
  `REDIS_URL` is required and the library throws if neither is set. Preserve that behavior.
- WebSocket upgrade requests bypass Express routing/middleware, so `resolveUserId` receives
  the raw `http.IncomingMessage`, never an Express `Request`. Keep that distinction in mind
  when touching `packages/express`.
- `disconnect(userId)` only closes local-instance connections by design (documented
  limitation) — don't silently "fix" this into cluster-wide behavior without discussion.
- Design specs and plans for larger changes live under `docs/superpowers/specs` and
  `docs/superpowers/plans` — check there for context before large features.

## Pull requests

- Keep `README.md` and each package's `README.md`/`LICENSE` in sync — the release workflow
  copies the root `README.md`/`LICENSE` into each package on release, so edit the root copies.
- PRs merge into `main`; `main` triggers CI, and a successful CI run on `main` triggers the
  release workflow (`semantic-release` per package). Don't bypass CI to merge.
