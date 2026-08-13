---
status: done-pending-review
size: small
branch: middlewright-0.1.5
pr: https://github.com/iterate/iterate/pull/2492
---

# middlewright 0.1.5 + lint rules

Status: review feedback addressed. Bumped from the pkg.pr.new pin to released
0.1.5 (patch retained — not upstreamed), all three lint rules on for specs
with NO exclusions: every one of the ~91 pre-existing require-timeout-comment
violations fixed properly (Misha rejected the config exclusion-list ratchet).
Review also drove real product work: decided approval batches now linger in
the mobile notifications list with their outcome instead of vanishing, and
spec helpers wait on the outcome badge (positive UI) rather than detachment.

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
      intentional expect().toBeVisible() workarounds: their disables now name
      only the middlewright rule, and `iterate/spec-restricted-syntax` skips
      toBeVisible/toContainText so each mistake reports once (with autofix)_
- [x] ~~`require-timeout-comment` exclusion-list ratchet~~ — _rejected in
      review ("don't hard-code file-by-file progress into the lint config");
      instead all ~91 violations were fixed: 6 repo-ide tab-click timeouts
      REMOVED (validated by running those specs), the rest annotated with the
      real reason each timeout exists (poll budgets outside spinner-waiter's
      reach, spinner-waiter-disabled blocks, popup pages without middleware,
      >30s cold-build/LLM budgets past the spinner ceiling)_
- [x] review: positive UI instead of detached waits — _decided batches now
      linger in the notifications list with their outcome (session-scoped,
      so device-independent history still doesn't accumulate); outcome badges
      got `approval-decision-badge` testIDs; decideBatch/rejectFromExpansion
      wait for the badge; the misleading "Signing…" label during rejects
      became "Deciding…"_
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
