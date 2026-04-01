# Preview PR Feedback Plan

PR: [#1229](https://github.com/iterate/iterate/pull/1229)

Reviewed inputs:

- inline PR comments from Jonas
- [jonasland/RULES.md](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/jonasland/RULES.md)
- [code-review-preview-pr-simplification.md](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/code-review-preview-pr-simplification.md)

## Summary

The current PR is too large and too opinionated about preview environments.

The immediate move is to cut obvious scope and duplication without debating architecture:

- remove preview-proof UI changes from all apps
- remove preview-only tests that existed only to prove the rollout
- simplify `alchemy.run.ts` in all apps by removing the `WORKER_ROUTES is required when deploying` guard entirely
- trim the Semaphore UI changes that expose preview-specific product behavior
- reduce workflow fan-out and generated YAML volume

After that, we should discuss the higher-level redesign before rewriting the core.

The main architectural concern is valid:

- `apps/semaphore` should probably not know that a lease is specifically a "preview environment"
- the preview system should likely be built on top of generic resource leasing with metadata, not as a new Semaphore-specific domain model

## Direct PR Comment Incorporation

These comments are unambiguous and should be treated as no-brainer cuts:

1. "i don't think the semaphore app should know about this particular use of semaphores"
   Current implication:
   - the preview-specific migration, contract types, service layer, and UI are overfit to one use case

2. "don't want any of this stuff - it doesn't belong in the semaphore app"
   Current implication:
   - preview-specific contract surface in [apps/semaphore-contract/src/contract.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore-contract/src/contract.ts) should be removed or drastically reduced

3. "let's rip all these out again now before we forget please - from all apps"
   Current implication:
   - the preview proof banners and host-based UI changes in app routes should be reverted

4. "we can delete this now"
   Current implication:
   - [apps/example/e2e/vitest/preview-smoke.e2e.test.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/example/e2e/vitest/preview-smoke.e2e.test.ts) should be removed

5. "just get rid of this whole WORKER_ROUTES is required when deploying in all apps"
   Current implication:
   - the route guard change should not be preview-specific; the guard itself should go away

6. "all the changes in this file and changes like this need to be undone"
   Current implication:
   - route-level preview proof code in app UIs should be reverted, not generalized

## Phase 1: No-Brainer Scope Cutting

This is the first pass I would make before discussing any redesign.

### 1. Remove preview-proof product UI changes

Revert preview-specific host loaders, banners, and slot-specific copy from:

- [apps/example/src/routes/\_app/debug.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/example/src/routes/_app/debug.tsx)
- [apps/events/src/routes/\_app/streams.index.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/events/src/routes/_app/streams.index.tsx)
- [apps/ingress-proxy/src/routes/\_app/routes.index.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/ingress-proxy/src/routes/_app/routes.index.tsx)
- preview-specific display additions in [apps/semaphore/src/routes/\_app/resources.index.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/src/routes/_app/resources.index.tsx)
- preview-specific display additions in [apps/semaphore/src/routes/\_app/resources.$type.$slug.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/src/routes/_app/resources.$type.$slug.tsx)

Reason:

- this code only existed to prove the rollout
- it bloats four apps for no durable product reason
- it should not be moved to shared code

### 2. Remove preview-proof test additions that are no longer needed

Delete:

- [apps/example/e2e/vitest/preview-smoke.e2e.test.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/example/e2e/vitest/preview-smoke.e2e.test.ts)

Then re-check whether [apps/example/e2e/vitest.config.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/example/e2e/vitest.config.ts) still needs to exist. If it only exists for the deleted smoke test, remove it too.

### 3. Simplify app deployment entrypoints

In all four apps:

- remove the `WORKER_ROUTES is required when deploying` guard
- keep `alchemy:up` / `alchemy:down` if they are still useful
- do not replace this with another shared abstraction unless a tiny helper is obviously justified

Target files:

- [apps/example/alchemy.run.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/example/alchemy.run.ts)
- [apps/events/alchemy.run.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/events/alchemy.run.ts)
- [apps/ingress-proxy/alchemy.run.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/ingress-proxy/alchemy.run.ts)
- [apps/semaphore/alchemy.run.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/alchemy.run.ts)

Reason:

- this is explicitly requested
- it simplifies the app code instead of adding preview-specific conditionals

### 4. Cut preview-specific Semaphore UI scope

For v1, the generic resource UI should stay generic.

Likely revert:

- preview-environment-specific projection in [apps/semaphore/src/routes/\_app/resources.index.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/src/routes/_app/resources.index.tsx)
- preview-environment-specific projection in [apps/semaphore/src/routes/\_app/resources.$type.$slug.tsx](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/src/routes/_app/resources.$type.$slug.tsx)

Keep only what still makes sense for generic resources.

Reason:

- preview UI is not the core feature
- it adds a second product surface and more model duplication

### 5. Reduce workflow bloat before redesigning behavior

Current state:

- one large source workflow helper
- four large generated deploy workflows
- one large cleanup workflow

Immediate simplification target:

- replace the four deploy workflows with one reusable preview deploy workflow plus small wrappers, or one matrix workflow

Important:

- this is a structural reduction, not a behavior redesign yet
- it should come before deeper Semaphore contract work because it removes the biggest line-count source fastest

## Phase 2: Higher-Level Design Discussion

This is the part I do **not** want to rewrite blindly without discussion.

### Main design question

How do we support preview environments without teaching `apps/semaphore` about preview environments as a first-class domain?

The likely direction is:

- Semaphore remains a generic resource leasing service
- resource acquisition can store explicit lease metadata
- preview-selection state lives outside Semaphore, probably in the PR comment state or workflow-owned state
- app-specific deployment logic owns the mapping from leased generic resource -> Doppler config / Alchemy stage / teardown behavior

### Proposed direction to discuss

#### Option A: Generic leases plus workflow-owned preview state

Semaphore responsibilities:

- generic resource inventory
- acquire / release / maybe renew
- store optional lease metadata

GitHub workflow responsibilities:

- decide which app pool to use
- remember which preview slot a PR most recently used
- recreate deployment on every push
- update sticky comment
- teardown on PR close

State location:

- lease metadata stored with the lease in Semaphore
- last-used preview identifier stored in the PR comment hidden state

Benefits:

- keeps Semaphore generic
- removes preview-specific DB table and much of the preview router surface
- aligns with the PR comments

Tradeoff:

- workflow/comment state becomes more important

#### Option B: Generic leases plus tiny app-owned preview helper

Same as Option A, but add a small shared helper in `packages/shared/src/apps` for:

- preview slot naming
- `stg_N` <-> stage <-> hostname derivation
- typed client calls to generic Semaphore procedures

Benefits:

- avoids repeating string conventions
- still keeps preview orchestration out of Semaphore

Tradeoff:

- adds a small shared helper, but this seems acceptable if it stays tiny and pure

#### Option C: Keep preview as a Semaphore domain

Not recommended.

Reason:

- conflicts with the review comments
- bloats public contract, DB schema, UI, and service logic
- is the main source of architectural discomfort in the current PR

## Concrete Rewrite Targets After Discussion

If we choose the generic approach, the likely rewrite is:

1. Delete preview-specific contract types and procedures from [apps/semaphore-contract/src/contract.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore-contract/src/contract.ts).
2. Delete preview-specific lifecycle code from [apps/semaphore/src/lib/preview-environments.ts](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/src/lib/preview-environments.ts).
3. Delete the preview assignment migration [apps/semaphore/migrations/0002_preview_assignments.sql](/Users/jonastemplestein/.superset/worktrees/iterate/gossamer-millennium/apps/semaphore/migrations/0002_preview_assignments.sql).
4. Replace it with generic lease metadata support on existing acquire/release flow if needed.
5. Keep preview naming and app manifest logic outside Semaphore, likely in a tiny shared helper or workflow-local module.
6. Rebuild the workflows on top of generic Semaphore leases and PR comment state.

## What Should Probably Stay

These parts still look directionally right:

- using Doppler `stg_1`, `stg_2`, `stg_3`, etc. as preview configs
- destroying and recreating on each PR push
- running deployed tests against the preview URL
- releasing on PR close / merge
- dogfooding oRPC or script entrypoints rather than ad hoc shell logic

## Proposed Execution Order

1. No-brainer cut pass:
   - remove preview proof UI
   - delete preview-only test additions
   - simplify `alchemy.run.ts`
   - trim preview UI extras
   - reduce workflow fan-out
2. Push that reduction as a cleanup commit.
3. Discuss the higher-level redesign with focus on keeping Semaphore generic.
4. Then do the architectural rewrite in a separate follow-up commit or PR update.

## Discussion Prompts For Next Step

When we discuss the redesign, the most useful questions are:

1. Should Semaphore store only generic lease metadata, with no preview-specific schema at all?
2. Should the sticky PR comment be the source of truth for “which preview slot this PR last used”?
3. Do we want a tiny shared preview helper in `packages/shared/src/apps`, or keep all preview naming in workflow-local code?
4. Is a single matrix-based preview deploy workflow acceptable, or do you want tiny per-app wrappers calling a reusable workflow?
