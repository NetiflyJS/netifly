# Docs Site (GitBook, Git Sync) — Design Spec

**Date:** 2026-09-27
**Status:** Approved for implementation planning
**Author:** dolufemi (with Claude Code)
**Tracking:** [NOT-24](https://linear.app/notifyjs/issue/NOT-24/docs-site-examples-and-launch-hn-rnode-devto-netifly-cloud-waitlist) (docs-site portion only)

## 1. Summary

NOT-24 bundles four things: a docs site, examples, a launch post, and a
Netifly Cloud waitlist link. This spec covers only the docs site. NOT-24's
attachments suggest VitePress or Astro Starlight as the static-site
generator, but the user has a GitBook organization ("Netifly", org id
`Pfhp13t8Qdottii2IT9N`) already connected via MCP with one empty site
("Netifly Docs", site id `site_ZBy5N`, one untitled default space, space id
`VLTBpm6rE2aQFHEqHXZX`) — GitBook is the chosen platform instead.

## 2. Goals

- Scaffold a full docs page tree covering the sections NOT-24 names:
  getting started, security, recipes ("email when offline", "notify from a
  BullMQ worker"), and API reference.
- Write complete content for the highest-value pages now (overview,
  getting started, security), sourced from the existing root `README.md`.
- Leave clearly-marked stubs for recipes and per-package API reference
  detail, so the tree is navigable and reviewable even before every page is
  fully written.
- Make the repo the source of truth: docs content lives under
  `docs/site/` in GitBook's Git Sync format (root `README.md` +
  `SUMMARY.md` + nested files), reviewed via normal PRs like any other
  change in this repo.
- Document the workflow (where docs live, how to add a page, how Git Sync
  connects) in `AGENTS.md` so it isn't tribal knowledge.

## 3. Non-goals

- Not wiring up Git Sync itself — GitBook's Git Sync configuration
  (pointing the "Netifly Docs" space at this repo/path, choosing initial
  sync direction) is UI-only; the MCP server cannot do it. That step is
  called out for the user to do after this PR merges.
- Not writing the examples (Express+React, worker publisher,
  docker-compose), the launch post, or the Cloud waitlist link — the other
  three NOT-24 bullets are out of scope here.
- Not producing final, exhaustive API reference prose for every option —
  stubs point at the README's existing tables/source until a follow-up
  fills them in.
- Not choosing VitePress/Starlight — superseded by the GitBook decision
  above.

## 4. Structure

```
docs/site/
  README.md                        — full: what Netifly is, package map, links
  getting-started.md               — full: install + quickstart (core, express, client)
  security.md                      — full: origin allowlist, cookie vs token auth, limits
  recipes/
    email-when-offline.md          — stub
    notify-from-a-bullmq-worker.md — stub
  reference/
    core.md                        — stub
    express.md                     — stub
    client.md                      — stub
  SUMMARY.md                       — GitBook Git Sync nav tree
```

Content for the "full" pages is adapted from the existing root `README.md`
(quickstart, security, redis config sections) rather than written from
scratch, so the docs site and README stay consistent at launch. Stub pages
carry a short outline plus a visible `> **Status:** stub — ...` marker so
reviewers and future contributors can tell what's unfinished.

## 5. AGENTS.md changes

Add a "Documentation" section stating:
- Docs source lives in `docs/site/`, in GitBook's Git Sync format.
- GitBook is the published target (via Git Sync), not VitePress/Starlight.
- Adding a page means adding the file under `docs/site/` **and** adding an
  entry to `docs/site/SUMMARY.md` — GitBook won't show a page that isn't
  in the summary.
- Git Sync connects the repo's `docs/site/` path to the "Netifly Docs"
  GitBook space; that connection is configured in the GitBook app, not
  from a coding session.

## 6. Testing / validation

No code paths are touched, so no `pnpm test`/`typecheck` implications.
Validation is: every `SUMMARY.md` entry resolves to a real file, and
internal relative links between docs pages resolve to files that exist.

## 7. Out of scope for this PR

Wiring Git Sync in the GitBook UI is the immediate next step after merge,
performed by the user, using the exact steps this spec documents in
AGENTS.md.
