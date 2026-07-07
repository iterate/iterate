---
status: in-progress
size: medium
branch: draft-prs-no-preview-lease
---

# Draft PRs don't get a preview lease unless they ask

## Status summary

Implemented and unit-tested; awaiting review. Policy function + deploy
wiring, workflow trigger types, marathon opt-out, docs, and the `preview`
label are all done. The new trigger types only take effect once this merges
(Depot registers triggers from the default branch).

## Problem

There are nine preview slots (`preview-1..9`), leased one-per-PR via the
semaphore. Every PR that touches preview paths claims a slot on open —
including draft PRs, which are the default for agent-generated work (bedtime
runs can open half a dozen drafts in one night). Drafts hold scarce slots
that ready-for-review PRs then queue behind ("All preview slots are leased —
this PR is waiting in line").

## Decision

Draft PRs do not claim a preview lease. A draft opts back in by any of:

1. **Adding the `preview` label** — the durable ask; previews then behave
   exactly as for a ready PR (deploy on every synchronize).
2. **Marking the PR ready for review** — previews start automatically.
3. **Explicit dispatch** — `depot ci dispatch ... --workflow
cloudflare-previews.yml --input pull-request-number=N` or a manual
   `pnpm preview deploy --allow-draft ...`. This is one-shot: the next
   synchronize re-applies the draft policy, so use the label for a lasting
   opt-in.

When a leased PR is converted to draft (or the `preview` label is removed
from a draft), the next lifecycle run tears its apps down and releases the
slot.

### Tradeoff (assumption, flagged for review)

Draft PRs lose the preview e2e signal until they opt in or go ready. We
think slot scarcity hurts more than early e2e helps — and marking ready
kicks off deploy+e2e automatically — but if we'd rather keep e2e-by-default
for drafts, invert the default and make this label opt-out instead.

## Design

The policy lives in `scripts/preview/preview.ts` (testable TypeScript), not
in workflow `if:` expressions. `resolvePullRequestPreviewContext` already
does `pulls.get`; it additionally records `draft` and label names. `deploy`
consults a pure decision function:

- ready PR, or draft with `preview` label, or `--allow-draft` → deploy as today
- draft without label, no lease held → skip: log + PR body notice explaining
  the three opt-in routes; claim nothing
- draft without label, lease held → tear down recorded apps and release the
  lease (same path as `cleanup`), with a notice saying why

`preview test` needs no change: with no lease recorded it already skips.

The workflow (`.depot/workflows/cloudflare-previews.yml`) grows trigger
types `ready_for_review`, `converted_to_draft`, `labeled`, `unlabeled` — all
routed to the existing preview job (the script decides what to do); `closed`
stays routed to cleanup. The workflow_dispatch path passes `--allow-draft`
since a dispatch is an explicit ask. Note: Depot only registers triggers
from the default branch, so the new event types take effect after merge.

## Checklist

- [x] pure decision function (draft/labels/allow-draft/lease-held → deploy | skip | teardown) with unit tests _`decideDraftPreviewPolicy` in preview.ts, exported via `previewInternals`; "draft preview policy" describe block in preview.test.ts_
- [x] context carries `draft` + labels from the existing `pulls.get` _`pullRequestIsDraft` + `pullRequestLabels` on `PullRequestPreviewContext`_
- [x] `deploy` applies the decision: skip with PR-body notice, or teardown + lease release _teardown reuses `cleanupPreviewForPullRequest`; both paths set the `draftPreviewNotice` banner (stable text, no timestamp, so repeat runs don't churn the PR body)_
- [x] `--allow-draft` flag on `preview deploy` (trpc-cli picks it up from the options type) _optional `allowDraft` on the deploy options_
- [x] workflow: new trigger types; dispatch passes `--allow-draft` _also a job-level `if` skips labeled/unlabeled events for labels other than `preview`, and the test asserts the trigger list + dispatch override string_
- [x] `flake-hunt-loop.sh` passes `--allow-draft` (marathon dispatches against an arbitrary PR)
- [x] docs: lease model section in `docs/dev-environments.md` _new "Draft PRs don't claim a slot unless they ask" invariant bullet_
- [x] create the `preview` label in the repo (one-time `gh label create`) _created during implementation_

## Implementation notes

- The claim path already clears the notice banner on success, so a draft
  that goes ready loses the "draft — no slot" banner on its first deploy.
- A one-shot `--allow-draft` deploy is deliberately reverted by the next
  synchronize: deploy sees a draft holding a lease without the label and
  tears it down. The label is the durable opt-in; documented in the docs
  and in the PR-body notice.
- `preview test` needed no change: teardown/skip leaves no recorded lease
  and the test lane already exits early in that case.
