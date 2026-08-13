---
status: done-pending-review
size: small
branch: middlewright-0.1.5
pr: https://github.com/iterate/iterate/pull/2492
---

# middlewright 0.1.5 + lint rules

Status: implementation complete, awaiting review. Bumped from the pkg.pr.new
pin to released 0.1.5 (patch retained — not upstreamed), all three lint rules
on for specs with a 20-file require-timeout-comment legacy exclusion
(burn-down: tasks/require-timeout-comment-ratchet.md). Lint/typecheck/knip/
format/tests green; signup spec passed live against the bump.

## Context

- Root `package.json` pins `middlewright` to
  `https://pkg.pr.new/middlewright@71c68659...` — 3 commits behind v0.1.5.
- `patches/middlewright.patch` (spinner-waiter disappearance-goal fix) is NOT
  upstreamed in 0.1.5, so the patch stays. It's keyed version-agnostically in
  `pnpm-workspace.yaml` and the patched file was untouched upstream since the
  pin, so it should re-apply cleanly.
- `.oxlintrc.json` already loads `middlewright/lint-plugin` in `jsPlugins` and
  enables `middlewright/require-timeout-comment` on 4 mobile spec files only.
- 0.1.5 ships three rules: `prefer-locator-waits` (fixable),
  `prefer-positive-waits` (new in 0.1.5), `require-timeout-comment`.

## Checklist

- [x] bump `middlewright` to `0.1.5` in root package.json, `pnpm install`,
      confirm the patch still applies — _pin swapped from pkg.pr.new URL;
      `readinessGoal` from patches/middlewright.patch present in installed
      dist, all three lint rules present_
- [x] enable all three `middlewright/*` rules for `specs/**` in `.oxlintrc.json`
      (drop the 4-file `require-timeout-comment` override in favour of the
      spec-wide one) — _added to the `specs/**/*.ts` override_
- [x] fix resulting lint violations — _3 `prefer-locator-waits` hits were
      intentional expect().toBeVisible() workarounds already carrying
      `iterate/spec-restricted-syntax` disables; extended those disables. 3
      `prefer-positive-waits` hits (decideBatch/rejectFromExpansion retry
      loops, orphan-row removal) got the rule's escape-hatch comments —
      detachment genuinely is the only signal there_
- [x] `require-timeout-comment` pre-existing violations — _91 across 20 legacy
      files; annotating all with invented reasons would be noise and removing
      timeouts unvalidated is risky, so those files are excluded via a config
      override; burn-down: tasks/require-timeout-comment-ratchet.md_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format` green — _all
      pass, plus full `pnpm test` (2780 tests); lint fix includes 2
      pre-existing prefer-logical-and-spread errors on main in
      note-composer.tsx_
- [x] run a specs smoke subset to confirm the bumped package + patch behave —
      _signup.spec.ts passed against local dev (spinner waiter + OTP flow in
      play)_

## Assumptions (made while Misha is AFK)

- The rules apply to `specs/**` (the playwright/middlewright surface), not
  repo-wide — `prefer-locator-waits` would be wrong for vitest e2e files.
- Pre-existing `require-timeout-comment` violations get ratcheted (excluded
  per-file with a burn-down task) rather than mass-annotated: the rule's own
  docs say comments must carry a real reason, and inventing 91 of them
  overnight would produce noise, while mass-removing timeouts can't be
  validated without the full spec suite.

## Implementation notes

- v0.1.5 == middlewright@a9e2030; the pkg.pr.new pin was 3 commits behind
  (missing "Require explanations for explicit timeouts" #25 follow-ups and
  "Prefer positive waits over detached waits" #28).
- patches/middlewright.patch (spinner-waiter disappearance-goal fix) is NOT
  upstreamed in 0.1.5 — spinner-waiter untouched upstream since the pin, patch
  re-applies cleanly (pnpm keys it version-agnostically).
- note-composer.tsx had 2 prefer-logical-and-spread errors on main (#2487
  lint rule crossed with #2483 mobile notes); autofixed here as a drive-by.
