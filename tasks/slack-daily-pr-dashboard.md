---
status: in-progress
size: small
---

# Slack daily PR dashboard

## Status summary

Fleshed-out spec committed; implementation not started yet.

## Problem

`.github/ts-workflows/workflows/merge-to-main-slack.ts` posts a Slack message to `#building` for *every* PR merged to main. On a busy day that's a dozen-plus messages of pure noise.

## Goal

Replace it with a workflow that maintains **at most one Slack message per day**: a daily PR dashboard. On every PR event:

- if today's dashboard message doesn't exist, post it
- if it does, update it in place (`chat.update`)

Desired shape (from the original ask):

```
PR dashboard 10th June

Merged:
- #1234 Add red button by Jonas (48fe16e)
- #1235 Add voice mode by Misha (deadbee)
Opened:
- #1236 Revert red button by Misha
Old: #991, #993, #1010
```

## Decisions (assumptions made while fleshing out — flagged where guessed)

- **Channel**: `#building`, same as the old workflow.
- **Day boundary**: UTC date. Simple and unambiguous; the team is distributed anyway. *(guess)*
- **Trigger**: `pull_request: [opened, closed, reopened, ready_for_review]` — no branch filter, so PRs targeting non-main branches (stacked PRs) show up too. No cron: quiet day → no message at all, which is the point. *(guess: original only watched merges to main)*
- **Finding today's message**: read the channel's recent history via `conversations.history` and look for a bot message from today starting with the dashboard title. Slack itself is the state store — no repo variables / caches / pinned issues to keep in sync. Requires the bot to have `channels:history`; verify with a local run before merging, and fall back to a repo Actions variable if the scope is missing.
- **Content** (all fetched fresh from the GitHub search API on each run, so the message is self-healing):
  - **Merged today**: `is:pr merged:>=<today>` — title, author, short merge sha.
  - **Closed today** (unmerged): `is:pr is:unmerged closed:>=<today>` — only shown if non-empty.
  - **Opened today**: `is:pr created:>=<today>` — title, author; mark drafts.
  - **Old**: open PRs created before today, one compact line of linked `#numbers` at the bottom.
- **No @-mentions**: names come from `slackUsers` github→handle mapping (fallback: github login), rendered as plain text. The message updates many times a day; pinging people on each update would recreate the noise problem.
- **Concurrency**: workflow-level `concurrency` group so two near-simultaneous PR events can't race and double-post.
- **Testability**: when run locally via `node cli.ts github-script` (no `eventName` in the simulated context), post to `#misha-test` instead of `#building`, mirroring `nag.ts`.

## Checklist

- [ ] flesh out + commit task file
- [ ] add `pr-dashboard.ts` workflow (ts-workflows) implementing the above
- [ ] delete `merge-to-main-slack.ts` + its generated yaml
- [ ] generate yaml (`node cli.ts from-ts`)
- [ ] verify Slack bot scopes / dry-run the script locally against `#misha-test`
- [ ] typecheck/lint/format
- [ ] open draft PR

## Implementation log

(notes added during implementation)
