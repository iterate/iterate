---
status: ready
size: medium
---

# Merged mobile PRs: swap the dead QRs for main's

## Status

Spec committed first for review; implementation follows on this branch.
Stacked on `mobile-build-state` (#2542) — it reuses that PR's
`ensureBuildForPr` / `installReady` helpers in `scripts/ci/mobile-preview.ts`.

## The problem

Merging a mobile PR leaves its body actively lying:

- Cleanup (`mobile-pr-preview-cleanup.yml`) deletes the PR's channel AND its
  QR image assets — so the body's QRs turn into broken images pointing at a
  channel that no longer exists.
- The way onto latest main after testing a PR is hunting the merge commit's
  commit comment for main's QR section. Nobody does that from a phone.

Misha's ask, verbatim: "I'd like the qr codes to get collapsed on merge, and
then when main's build completes a CI job should find the corresponding PR
and put *main's* QR code(s) in the PR body — that will make it easier to get
onto latest main without hunting for commit comments."

## Design

Three touches, all riding existing machinery (the managed
`mobile-pr-preview` body section via `markdownAnnotator`):

1. **On close** (`cleanup-mobile-pr-preview.ts`): after deleting
   channel/assets, rewrite the section. Merged → a placeholder: "merged —
   channel deleted; main's QRs land here when main's publish completes".
   Closed unmerged → "closed — preview channel deleted". Guard: never
   overwrite a section that is already main-flavored (the publisher may win
   the race with the close event).
2. **On the merge push** (`publish-mobile-update.ts`): after publishing to
   `preview` and ensuring main's install build, find the PR(s) the pushed
   commit belongs to (`listPullRequestsAssociatedWithCommit`), and for each
   MERGED one whose body carries the section, write the main-variant section
   — the same one commit comments get: OTA switch-to-main QR (usable
   immediately for JS-only merges) + main's install build (marked "build
   still running" when freshly triggered).
3. **When the build completes** (new `refresh-mobile-main-qr.ts`, second
   workflow job): a native-change merge triggers main's build `--no-wait`,
   so step 2 writes a pending install link. This job polls the build until
   it finishes (bounded), then re-renders the same sections with the
   installable link. The publish job keeps the serializing concurrency
   group; this job runs outside it so a 20-minute build never queues later
   merges — concurrency moves from workflow-level to the publish job.

## Checklist

- [ ] `cleanup-mobile-pr-preview.ts`: rewrite the body section on close
  (merged vs not), pure-planner tested, skip if already main-flavored
- [ ] `publish-mobile-update.ts`: find merged PRs for the pushed commit,
  write the main section into each body that has one
- [ ] `refresh-mobile-main-qr.ts`: poll main's install build to FINISHED,
  re-render the PR sections (and the commit comment) with the live link
- [ ] `mobile-eas-update.yml`: concurrency to the publish job; add the
  refresh job (needs: publish, gets build id + PR numbers via outputs)
- [ ] Tests alongside the existing pure planners in
  `mobile-preview.test.ts` / `cleanup-mobile-pr-preview.test.ts`
- [ ] README: "Per-PR channels" lifecycle paragraph mentions the swap

## Decisions made without asking

- Step 2 writes immediately rather than waiting for the build: the OTA QR is
  the common case (JS-only merges) and should not wait ~20 minutes for a
  build only native merges need. The pending install link is honest
  (`installReady` from #2542) and step 3 upgrades it.
- Closed-unmerged PRs also get their section neutered — their QR images are
  deleted either way, and broken images are worse than a one-line note.
- Polling over EAS webhooks: no webhook infra exists, and a bounded poll in
  a non-serialized job is ~30 lines. Webhooks can replace it if polling ever
  bites.
