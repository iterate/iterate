---
state: todo
priority: high
size: large
tags: [ci, depot, infra, docs]
---

# Move all Depot-compatible CI workflows to Depot CI (+ document it)

Preview deploy/e2e/cleanup already runs on Depot CI
(`.depot/workflows/cloudflare-previews.yml`). Move the rest of the generated
GitHub Actions workflows onto Depot CI too, for the same ~7s pickup (vs GitHub's
20s-3m39s runner assignment).

## Scope

Movable (Depot-supported triggers — push / pull_request / schedule /
workflow_dispatch / workflow_call / workflow_run / pull_request_review):

- lint-typecheck, test, autofix, ci, nag, pr-dashboard (per-PR checks — the
  speed win)
- deploy-os / deploy-auth / deploy-semaphore / deploy-streams-example-app /
  deploy-tunnels, deploy, release, pullfrog (prod deploys — validate carefully)

**Stays on GitHub Actions:** `claude-assistant` — it triggers on
`issue_comment`, `issues`, and `pull_request_review_comment`, none of which
Depot CI supports. (Depot DOES support `pull_request_review` — review
submitted — just not the comment/issue events.) So "all" is really
"all except claude-assistant".

## How

- The workflows are generated from `.github/ts-workflows/workflows/*.ts` into
  `.github/workflows/*.yml` by `.github/ts-workflows/cli.ts`. Retarget the
  generator to emit `.depot/workflows/*.yml` for the moved workflows (or emit
  both and delete the GitHub copies) and update the drift check.
- Secrets: ensure everything each workflow needs is in `depot ci secrets`
  (currently only DOPPLER_TOKEN + ITERATE_BOT_GITHUB_TOKEN, and those are
  interim personal tokens — swap for the iterate-bot PAT + a Doppler service
  token).
- Watch: branch-protection required-check names stay the same (Depot GitHub
  App reports the same check names), but confirm before flipping. Depot
  registers pull_request/etc. triggers only when the file is on the DEFAULT
  branch.

## Documentation (rolled into this PR — asked for explicitly)

Add a doc **discoverable directly from the repo root `README.md` in one hop**
that explains how Depot CI works here and how to interact with it:

- what Depot CI is and why we use it (pickup latency vs GitHub Actions)
- where the workflows live (`.depot/workflows/`) and how they're
  triggered/registered (default-branch registration caveat)
- the important CLI commands: `depot ci run list` / `workflow list` /
  `status <run>` / `logs <attempt> [--timestamps] [--output-file]` /
  `metrics --run <id>` / `dispatch --workflow <name> --ref <branch> --input k=v`
  / `secrets` (add/list/remove) / `run --workflow <file>` (local, uploads
  uncommitted patch)
- gotchas: workflow_dispatch vs pull_request runs share the concurrency group
  and cancel each other; `logs --output-file` lags a live run; `status`
  run-id vs workflow-id confusion
- links: depot.dev/docs/ci (quickstart, compatibility, CLI reference), the org
  dashboard (https://depot.dev/orgs/0p91s0lz49/workflows)

Extend/point to the existing "Depot CI" section in `docs/ci-workflows.md`
rather than duplicating.
