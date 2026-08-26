status: in-progress
size: medium
branch: fix/restore-ai-linter-rules

# Restore GitHub AI lint reviews

Status: Production policy v7 is live. `iterate[bot]` reported the deliberate
metaphor with explanation-only comments and no suggested-change patch. Static
and focused checks pass; CI still has the unrelated expired parked-test date.

## Goal

Restore `iterate[bot]` reviews for this repository and add an AI lint rule that
rejects metaphorical uses of `lane`, `door`, and `seam` unless a nearby comment
explains why the word is literal or justified.

## Assumptions

- Root `rules/**/*.md` remains the canonical rule source for this repository.
- The rule should target identifiers and prose in code, not genuine traffic
  lanes, physical doors, or actual joined/material seams.
- A short comment immediately above an intentional non-literal use is the
  explicit escape hatch.
- Metaphor diagnostics explain the unclear concept but do not propose a rename
  or publish a GitHub suggested-change patch.
- The task is complete only when a deliberately offending variable in this PR
  causes a visible `iterate[bot]` review comment.

## Checklist

- [x] Reproduce the missing AI lint run from a fresh PR and capture the failed stage. _Production had no `/repos/iterate` route after the August 8 recreation; restoring it then exposed the obsolete SDK's exact durable processor error._
- [x] Repair the stale rule-loading/configuration path without hiding failures. _Restored `/repos/iterate`; config commit `f059bea` pins the current subscription API, recreates the source link after future restores, and produced `project/worker-updated` plus an active `review-bot` subscription._
- [x] Add the banned-metaphor rule to the canonical rules and hosted linter config. _Added `terminology/no-metaphorical-lane-door-seam` to root policy, the default template, and production config policy v7._
- [x] Add one obvious offending variable solely as an end-to-end review probe. _`configs/default/worker.ts` names the rule-path array `reviewLane` without an exception._
- [x] Prove `iterate[bot]` comments on that variable, then preserve the proof in the PR. _Review `5016262887` and inline comments `3850695732`/`3850695742` flag `reviewLane` under the new rule._
- [x] Prove the metaphor diagnostic is explanation-only, even if the model emits a fix. _Policy-v7 review `5029789862` and comments `3862225098`/`3862225102` explain the unclear role without a replacement or suggestion fence; publisher regression coverage also strips a model-supplied patch._
- [x] Run focused tests and checks for every changed code/config surface. _Template typecheck and 36 focused tests pass; full typecheck, lint, Knip, and formatting pass. The full test aggregate reaches an unrelated expired `revisit by 2026-08-24` marker in `specs/mobile/media.spec.ts`._
- [ ] Move this task to `tasks/complete/` once the live proof and CI are green.

## Implementation log

- 2026-08-25: Started from `origin/main` in a dedicated worktree. Initial
  inspection found that `configs/default/worker.ts` still configures the deleted
  `rules/structure/no-small-single-use-helper.md`, while the canonical root rule
  was replaced by four newer structure rules in PR #2305.
- 2026-08-25: GitHub history showed the last `iterate[bot]` review on August 6.
  Production project `prj_f80006b6f56e466592117d896d0eaec0`, recreated on
  August 8, contained only `/repos/config`; the linter router therefore had no
  route for repository ID `1057144703` (`iterate/iterate`).
- 2026-08-25: The GitHub installation remained connected and could access the
  repository, so no integration reinstall was needed. Recreated and linked
  `/repos/iterate` at commit `d40cf451`; the link event then durably failed with
  `Cannot read properties of undefined (reading 'app-review-bot#review-bot')`.
- 2026-08-25: The production config package was pinned to pre-redesign commit
  `bdfb9a`; OS had moved to named subscriptions in `ffe683` on August 6. Pushed
  config commit `f059bea` with compatible package commit `bde72e`, policy v6,
  the new rule, and project-specific repo reconciliation. Production imported,
  built, and served that exact commit and installed active `review-bot`.
- 2026-08-25: The compatible SDK reveals that the config repo's unimported
  `voice-agent.ts` still uses removed `consumesEphemeral` types. It does not enter
  the project-worker/linter build; migrate it separately before the next voice
  agent deployment rather than mixing that large change into this repair.
- 2026-08-25: PR #2514's `ready_for_review` delivery created the linter child,
  loaded policy v6 from config commit `f059bea`, reported two
  `terminology/no-metaphorical-lane-door-seam` diagnostics, and published
  comment-only review `5016262887` plus a neutral Check Run. The review-bot
  connection subscription finished at zero lag with no recorded error.
- 2026-08-26: Added a generic per-rule `suggestions` policy. Rules default to
  `allowed`, while the metaphor rule uses `forbidden`; the agent prompt omits a
  fix and the mechanical publisher refuses to render one even if supplied.
- 2026-08-26: Production config commit `b03c198` pins the linter package from
  this PR and activates policy v7. OS published `project/worker-updated` for
  that exact commit; the refreshed `review-bot` subscription is active.
- 2026-08-26: Analysis `5982` used policy v7, prompt v4, and config `b03c198`.
  Its two durable diagnostics contained no `fix`; `iterate[bot]` review
  `5029789862` published the same explanation-only comments with no suggestion
  fences.
