---
status: done
size: small
---

# Remove the draft-PR preview skip and the `preview` label

Draft PRs currently skip preview deploy + e2e unless they wear the `preview`
label, are marked ready, or a human dispatches with `--allow-draft`. Misha:
"get rid of the draft-doesnt-get-preview thing it's too annoying" — and remove
the `preview` label logic and everything downstream of it.

Rationale: the policy dated from a nine-slot fleet that a busy bedtime of
agent-opened drafts could exhaust. The fleet is nineteen slots now, and the
policy costs more in confusion (PRs silently without previews) than it saves
in capacity. If contention returns, `tasks/stealable-preview-leases.md` is the
finer-grained fix.

## Checklist

- [x] remove `decideDraftPreviewPolicy`, the skip/teardown branches, `previewOptInLabel`, the draft PR-body notice, and `--allow-draft` from `scripts/preview/preview.ts` _— deploy now always claims a slot; dispatch keeps `--all-apps` only_
- [x] drop draft/label lifecycle triggers (`ready_for_review`, `converted_to_draft`, `labeled`, `unlabeled`) and the label-filter job `if:` from `.depot/workflows/cloudflare-previews.yml` _— `opened`/`reopened`/`synchronize` suffice_
- [x] simplify `preview status` diagnosis: no more "preview-eligible" split _— `previewEligibleWithoutSlotCount` → `openWithoutSlotCount`; open-PR listing no longer fetches draft/label state_
- [x] update tests _— deleted the policy suite; kept a dispatch `--all-apps` assertion; diagnosis fixtures simplified_
- [x] docs: CLAUDE.md, README.md, docs/pull-requests.md, docs/dev-environments.md, docs/adding-preview-slots.md _— canary runbook no longer labels drafts_
- [x] mark `tasks/stealable-preview-leases.md` as premise-removed _— status: maybe, only relevant if slot contention returns_

## Implementation notes

- The workflow's `on:` triggers are registered from the default branch, so
  drafts start getting previews once this merges. The preview *script* runs
  from the PR head though, so this PR itself deploys a preview despite being
  a draft — self-demonstrating.
- Existing `preview`-labeled PRs are unaffected; the label just becomes inert.
- `pr-dashboard.yml` keeps its `converted_to_draft` trigger — that's for the
  dashboard, unrelated to the preview policy.
