# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project overview

Netifly (npm scope `@netiflyjs`) is a pnpm workspace monorepo providing framework-agnostic,
real-time per-user notifications for Node.js servers (WebSockets + Redis pub/sub).

- `packages/core` — `@netiflyjs/core`, the framework-agnostic engine.
- `packages/express` — `@netiflyjs/express`, a thin Express adapter over `core`.
- `packages/client` — `@netiflyjs/client`, the browser/Node WebSocket client.
- `packages/react` — `@netiflyjs/react`, a provider and hooks on top of `client`.
- `examples/` — standalone example apps (not published) demonstrating the packages above.

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

**All work happens on a branch; `main` only moves via merged pull requests.** Never commit
directly to `main` — create a branch, commit there, push it, and open a PR. This holds even
for small fixes and docs-only changes.

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

## Package metadata

Every publishable package's `package.json` must include a `keywords` array — these are the
tags npm uses for search/discoverability. Include `netifly`, the technologies it wraps
(`websocket`, `redis`, etc.), and its category (`notifications`, `realtime`, framework name
for adapters). Add this when scaffolding any new package under `packages/`.

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

## Documentation

The published docs site (GitBook, org "Netifly") is **Git Synced** to `docs/site/`
in this repo — that folder is the source of truth, not GitBook's editor.

- Content lives in `docs/site/` using GitBook's Git Sync format: a root
  `README.md` (the site's front page), a `SUMMARY.md` that defines the nav
  tree, and nested folders/files matching it (e.g. `recipes/`, `reference/`).
- **Adding a page means two edits**: the file under `docs/site/`, *and* an
  entry in `docs/site/SUMMARY.md` — GitBook will not display a page that
  isn't listed there. Every link in `SUMMARY.md` and between docs pages must
  resolve to a real file (see `docs/superpowers/specs/2026-09-27-docs-site-design.md`
  for the validation approach used when this was scaffolded).
- Some pages are intentionally stubs (marked with a `> **Status:** stub`
  line) — recipes and per-package API reference detail. Expanding them is
  ordinary docs work: edit in place, remove the stub marker once complete.
- Git Sync itself (connecting the GitBook space to this repo/path, choosing
  sync direction) is configured in the GitBook app, not from a coding
  session — this MCP/CLI cannot wire that up. If Git Sync ever needs
  reconnecting, that's a manual step in GitBook's UI, not something to
  script around.
- Treat `docs/site/` like code: change it on a branch, open a PR, get it
  reviewed. On merge, GitBook picks up the change automatically via Git
  Sync (Git → GitBook direction).

## Pull requests

- Keep `README.md` and each package's `README.md`/`LICENSE` in sync — the release workflow
  copies the root `README.md`/`LICENSE` into each package on release, so edit the root copies.
- `main` only advances via a merged PR from a branch (see Branching above) — never a direct
  push or commit to `main`. `main` triggers CI, and a successful CI run on `main` triggers the
  release workflow (`semantic-release` per package). Don't bypass CI to merge.
