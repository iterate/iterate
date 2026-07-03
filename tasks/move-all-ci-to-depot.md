---
state: in-progress
priority: medium
size: medium
tags: [ci, depot, infra, docs]
---

# Finish moving CI to Depot (6 slack/coupled workflows remain)

Most of this is **DONE** — PR #1613 (merged 2026-07-03) moved the 7
Depot-satisfiable workflows onto the baked image: `lint-typecheck`, `test`,
`deploy-auth`, `deploy-tunnels`, `release`, `autofix`, `pullfrog`. They run on
`runs-on: { image: …iterate-preview-ci… }` with `setupFromImage` +
`setupDopplerBaked` (Doppler is baked into the image — no per-run install) and
need only Depot's existing `DOPPLER_TOKEN` (+ `ITERATE_BOT_GITHUB_TOKEN` for the
github-script jobs). Validated green on `main`.

## What's left, and the real blockers

Six workflows are still on GitHub Actions. Two hard blockers:

1. **Slack token.** `ci`, `nag`, `pr-dashboard`, and the cloudflare-app deploys
   (`deploy-os`, `deploy-semaphore`, `deploy-streams-example-app` — their
   `slack-success`/`slack-failure` jobs) post with `SLACK_CI_BOT_TOKEN`.
   **CORRECTION to the old assumption:** that token is a **GitHub repo secret**;
   it is NOT in Depot's secrets and NOT in Doppler `_shared/prd` (swept every
   project/config 2026-07-03 — not there). `ITERATE_BOT_GITHUB_TOKEN` likewise
   is a direct Depot secret, not in `_shared/prd`. So the "slack.ts already
   Doppler-falls-back" story does NOT work today — the fallback would fail on
   Depot because the token isn't in Doppler.
2. **Reusable-workflow coupling.** `deploy` is `workflow_call`-only, invoked by
   `ci.yml` via `./.github/workflows/deploy.yml`. A GitHub Actions workflow can
   only call a reusable workflow under `.github/workflows/` — never `.depot/` —
   so `deploy` stays wherever `ci` is, and `ci` is slack-blocked.

Permanent GitHub stayers: `claude-assistant` (issue_comment/issues triggers
Depot doesn't support), `generate-workflows` (the self-referential guardian).

## To finish (one-secret end state)

1. Put `SLACK_CI_BOT_TOKEN` into Doppler `_shared/prd` (the config Depot's
   `DOPPLER_TOKEN` resolves). This is the only new secret material needed.
2. Rewire the `getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}")` call sites
   (ci.ts, nag.ts, pr-dashboard.ts, cloudflare-app-workflow.ts) to the no-arg
   `getSlackClient()` (Doppler fallback via `getSlackBotToken()`), and run those
   jobs under a Doppler context (`setupDopplerBaked` + `DOPPLER_TOKEN` env).
3. Add `ci`, `nag`, `pr-dashboard`, `deploy-os`, `deploy-semaphore`,
   `deploy-streams-example-app` to `DEPOT_WORKFLOW_NAMES`. Move `deploy` in the
   same step as `ci` and change its `uses:` from `./.github/workflows/deploy.yml`
   to `./.depot/workflows/deploy.yml`.
4. Regenerate (`pnpm workflows`) and confirm drift-clean.
5. Merge and babysit `main` — Depot evaluates `.depot` workflows on the PR head
   for `pull_request`, so they DO validate pre-merge (proven on #1613); the
   push-to-main runs are the real cutover to watch.

## Notes

- Interim: Depot's `DOPPLER_TOKEN` is Jonas's personal token — swap for the CI
  Doppler service token scoped `_shared/prd` at some point.
- `main` has no required status checks (Protect Main ruleset), so a moved check
  can't block merges; `gh pr merge --admin` (Jonas is a bypass actor).
- See docs/depot-ci.md for the full usage/command reference + this runbook.
