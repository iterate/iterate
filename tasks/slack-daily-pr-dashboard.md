---
status: in-progress
size: small
---

# Slack daily PR dashboard

## Status summary

Done, pending review: PR at https://github.com/iterate/iterate/pull/1448. Implemented, dry-run tested locally, and e2e tested in CI against `#misha-test` — both the create path (post + store ts) and the update-in-place path were exercised by real workflow runs. Nothing known missing.

## Problem

`.github/ts-workflows/workflows/merge-to-main-slack.ts` posts a Slack message to `#building` for _every_ PR merged to main. On a busy day that's a dozen-plus messages of pure noise.

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
- **Day boundary**: UTC date. Simple and unambiguous; the team is distributed anyway. _(guess)_
- **Trigger**: `pull_request: [opened, closed, reopened, ready_for_review]` — no branch filter, so PRs targeting non-main branches (stacked PRs) show up too. No cron: quiet day → no message at all, which is the point. _(guess: original only watched merges to main)_
- **Finding today's message**: the message `ts` is stored in a repo Actions variable (`SLACK_PR_DASHBOARD_STATE`, JSON `{date, channel, ts}`), written with `ITERATE_BOT_GITHUB_TOKEN` (same PAT `nag.ts` uses). ~~Read the channel's recent history via `conversations.history`~~ _(rejected: would require a `channels:history` scope the bot may not have, and the token isn't accessible locally to verify; the repo-variable approach was verified working with a live create/read/delete test and needs no new Slack scopes — `chat.update` uses the same `chat:write` the bot already exercises)_
- **Content** (all fetched fresh from the GitHub search API on each run, so the message is self-healing):
  - **Merged today**: `is:pr merged:>=<today>` — title, author, short merge sha; `into branch` noted when the base isn't main.
  - **Closed today** (unmerged): `is:pr is:unmerged closed:>=<today>` — only shown if non-empty.
  - **Opened today**: `is:pr is:open created:>=<today>` — title, author; mark drafts. Only _still-open_ PRs, otherwise busy days list every same-day-merged PR twice.
  - **Old**: open PRs created before today, one compact line of linked `#numbers` at the bottom.
- **No @-mentions**: names come from `slackUsers` github→handle mapping (fallback: github login), rendered as plain text. The message updates many times a day; pinging people on each update would recreate the noise problem.
- **Concurrency**: workflow-level `concurrency` group so two near-simultaneous PR events can't race and double-post.
- **Testability**: pushing a branch matching `*pr-dashboard*` runs the workflow for real but posts to `#misha-test` (and uses a separate `_TEST` state variable), mirroring `nag.ts`. Running locally via `node cli.ts github-script` prints the message instead of posting (the Slack secret is an unexpanded `${{ ... }}` literal locally, used as a dry-run signal).

## Checklist

- [x] flesh out + commit task file _(committed first in isolation)_
- [x] add `pr-dashboard.ts` workflow (ts-workflows) implementing the above _(`.github/ts-workflows/workflows/pr-dashboard.ts`)_
- [x] delete `merge-to-main-slack.ts` + its generated yaml
- [x] generate yaml (`node cli.ts from-ts`) _(`.github/workflows/pr-dashboard.yml`)_
- [x] verify Slack bot scopes / dry-run the script locally against `#misha-test` _(dry run via `node cli.ts github-script pr-dashboard.update_dashboard.update_pr_dashboard --github-token ...`; full message rendered correctly. Slack-scope concern dissolved by switching state store to a repo Actions variable)_
- [x] typecheck/lint/format _(ts-workflows `tsc`, root `oxlint` + `oxfmt` all clean)_
- [x] open draft PR _(https://github.com/iterate/iterate/pull/1448)_
- [x] confirm push-triggered e2e run posts/updates the dashboard in `#misha-test` _(run 27280068182 posted + created `SLACK_PR_DASHBOARD_STATE_TEST`; a later run logged "Updated existing dashboard message", confirming update-in-place)_

## Implementation log

- Verified `SLACK_CI_BOT_TOKEN` is **not** retrievable from any locally-accessible Doppler project/config — it only exists as a GitHub Actions secret. That ruled out locally verifying Slack scopes, which motivated the repo-variable state store (verified writable via a live `gh api` create/read/delete test).
- The search API needs `advanced_search: "true"` to avoid the legacy-endpoint deprecation.
- Search results don't carry `merge_commit_sha` or base branch, so merged PRs get an extra `pulls.get` each (bounded by per-day merge count).
- First dry run on a busy day (~25 merges) showed every same-day-merged PR duplicated under "Opened … (already closed)" — narrowed Opened to `is:open`.
- First CI run failed as a malformed workflow file: the dry-run check `slackToken.includes("$" + "{{")` put a literal unclosed expression-opener in the yaml. Detect the unexpanded secret by name instead.
- Second CI run exposed a Slack API asymmetry on busy days: `chat.postMessage` silently truncates long text but `chat.update` rejects it with `msg_too_long`, and the fallback then posted a second message — the exact noise problem this task removes. Fixed by chunking lines into 2900-char mrkdwn section blocks (3000-char/50-block limits give ~35x more headroom), with the heading as notification fallback text.
