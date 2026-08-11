---
status: in-progress
size: small
---

# Self-heal stale project-directory slug entries

## Status

Spec + implementation in one sitting; small change. See PR.

## Problem (observed live on preview-14)

The os project-directory KV cache is deliberately no-expiry ("slugs are
immutable, create overwrites its keys" — `project-directory.ts`). That
invariant breaks whenever a slug's auth-side row is deleted and the slug is
later re-registered with a new id:

- preview erase cycles: e2e signups all derive org/project `nustom` from
  `*+test@nustom.com` emails, so successive lease/erase cycles recreate the
  same slug with fresh ids while a KV entry survives;
- prod: delete a project in the auth UI, recreate the slug — os routes the
  slug to the dead id forever.

Observed failure: `?ensureBirth` runs
`projects.get("nustom").create({projectId: prj_NEW})`; the handle resolved
stale `prj_OLD` from KV, and create()'s id-mismatch guard throws →
"Project setup could not be resumed" toast on every reload, project never
born. Auth D1 (source of truth) knew only `prj_NEW`.

## Fix

When create() receives an explicit `projectId` that disagrees with the
handle's id, treat the auth worker as tiebreaker instead of failing:

- [ ] `readProjectBySlugAuthoritative(directory, slug)` in
      `project-directory.ts`: skip the positive KV cache, ask
      `AUTH.getProjectBySlug` directly; on a hit re-prime the cache
      (best-effort) and return the record; null when auth has no row
      (admin-lane projects live only in KV — never heal those away).
- [x] in `ProjectRpcTarget.create()`: on id mismatch, resolve the handle's
      current slug authoritatively; if auth maps it to the caller's id,
      re-key the handle to that project (widen + assert access, rebuild
      props) and continue; otherwise throw the original mismatch error.
- [x] unit tests for the helper (auth hit → record + re-prime + memo
      refresh; auth miss → null, no prime).

Out of scope: proactively invalidating KV on auth-side project delete
(cross-worker choreography; the lazy heal covers the read path that
matters).
