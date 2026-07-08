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
that migration needs real consideration. Until then we want *some* way to view
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

- [ ] add shared `repoPathToSplat` / `repoPathFromSplat` helpers with `~` sentinel
- [ ] use them in the repos index route (list link + create-repo navigate)
- [ ] use them in the repo detail route (splat → repo path)
- [ ] unit test the round-trip, including `/`
- [ ] typecheck / lint / relevant tests
- [ ] draft PR clearly marked as a temporary hack until `/` → `/repos/config`
