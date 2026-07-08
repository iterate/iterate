---
status: in-progress
size: small
temporary: yes — remove when the `/` repo is replaced by `/repos/config`
---

# Repo viewer: make the legacy `/` repo viewable (temporary hack)

## Status summary

Being implemented now. The fix is a sentinel URL segment (`~`) that maps to the
root repo path `/` in the repo viewer routes. No backend changes.

## Problem

The new repo viewer at `/projects/$projectSlug/repos/$` addresses a repo by
putting the suffix of its path (after `/repos/`) into the splat. The legacy
project repo lives at the stream root path `/` (`PROJECT_REPO_PATH`), so its
link becomes `/projects/misha/repos//`, which URL normalization collapses to
`/projects/misha/repos` — the index page. The `/` repo is therefore impossible
to view.

We plan to get rid of the `/` repo entirely (moving to `/repos/config`), but
that migration needs real consideration. Until then we want _some_ way to view
it. Any simple hack is acceptable; it must be clearly marked as temporary.

## Approach (assumptions, made while Misha is AFK)

- Use a sentinel splat: URL segment `~` ⇔ repo path `/`. Chosen because it's a
  single readable character and an unlikely real repo name; a real repo at
  `/repos/~` would collide, but this is a knowingly-temporary hack.
- Put the splat⇔path mapping in one shared helper module
  (`apps/os/src/lib/repo-splat.ts`) with a loud TEMPORARY HACK comment, replacing
  the two private helpers currently duplicated across the index and detail
  routes. That gives one place to delete when `/` goes away.
- No backend changes: `itx.repos.get("/")` already works (paths are
  normalized), and the project processor already lists `/` in its repos state.

## Checklist

- [x] add shared `repoPathToSplat` / `repoPathFromSplat` helpers with `~` sentinel — _`apps/os/src/lib/repo-splat.ts`, loud TEMPORARY HACK comment_
- [x] use them in the repos index route (list link + create-repo navigate) — _replaced the private `repoPathToSplat` at the bottom of `repos/index.tsx`_
- [x] use them in the repo detail route (splat → repo path) — _replaced the private `repoPathFromSplat` in `repos/$.tsx`_
- [x] unit test the round-trip, including `/` — _`apps/os/src/lib/repo-splat.test.ts`_
- [x] typecheck / lint / relevant tests — _all green_
- [x] draft PR clearly marked as a temporary hack until `/` → `/repos/config` — _https://github.com/iterate/iterate/pull/1765_
- [ ] verify in a running dev server that `/projects/<slug>/repos/~` shows the root repo

## Implementation notes

- `stream-routes.ts` deliberately untouched: the `/` stream is the project root
  stream, so ⌘K/breadcrumb navigation for `/` lands on the project page, which
  is unchanged (and correct) behavior. Only the repos index link and direct
  repo-viewer URLs needed the sentinel.
- `itx.repos.get("/")` already works — `normalizePath` accepts it and the
  project processor already lists `/` in its `repos` reduced state, so the
  index table row for `/` existed but linked to a URL that normalized away.
