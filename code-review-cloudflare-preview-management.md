# Code Review: Cloudflare Preview Management

## Findings

### Medium: The new shared workflow still does four full repo setups and installs per PR run

- Rules: "We want to have few abstractions" and "ideally i'd like them to find opportunities to delete lots more code"
- Files:
  [.github/ts-workflows/workflows/cloudflare-previews.ts](/Users/jonastemplestein/.superset/worktrees/iterate/juniper-newsprint/.github/ts-workflows/workflows/cloudflare-previews.ts#L28)
- Why this is a problem:
  The workflow serializes a matrix over all preview apps, but every matrix cell still does checkout, Node setup, and `pnpm install`, even when `preview sync` immediately decides the app is unchanged. That keeps the old per-app duplication cost, only moved into one workflow. It is a CI-time regression and leaves a lot of deletable orchestration code on the table.
- Option A:
  Replace the matrix with one job that sets up the repo once and then loops over `cloudflarePreviewApps` serially in a shell or TS step.
- Option B:
  Keep the matrix, but add a pre-job that computes the touched apps and emits a reduced dynamic matrix for sync runs.
- Recommendation:
  Option A. It deletes the most workflow code and matches the new single-owner architecture better.

### Medium: `scripts/preview/state.ts` re-implements existing markdown state helpers and exports too much surface

- Rules: "We want to have few abstractions", "Don't declare or export infrequently used things", "Write invisible typescript"
- Files:
  [scripts/preview/state.ts](/Users/jonastemplestein/.superset/worktrees/iterate/juniper-newsprint/scripts/preview/state.ts#L6)
  [.github/ts-workflows/utils/github-script.ts](/Users/jonastemplestein/.superset/worktrees/iterate/juniper-newsprint/.github/ts-workflows/utils/github-script.ts#L131)
- Why this is a problem:
  The new file adds another copy of markdown block annotation/state logic even though the repo already has `markdownAnnotator` and `prState`. It also exports schemas, types, and render/parse helpers that are not primary APIs. The result is more reusable-looking surface area and more code than the comment version actually needed to remove.
- Option A:
  Extract the generic markdown state helper into a small shared module and reuse it from both places, then keep only the preview-specific rendering in `scripts/preview`.
- Option B:
  Collapse `state.ts` back down so it only exports `readCloudflarePreviewState`, `upsertCloudflarePreviewStateEntry`, and `clearCloudflarePreviewDestroyPayload`, with the markdown helpers and schemas file-local.
- Recommendation:
  Option A if you want shared reuse to be real; otherwise Option B is the fastest deletion pass and is still a net improvement.

### Medium: The workflow still hardcodes the preview CLI argument choreography three times

- Rules: "Everything that can be, should be an orpc procedure", "Abstractions need to be easy to explain", "We want to have few abstractions"
- Files:
  [.github/ts-workflows/workflows/cloudflare-previews.ts](/Users/jonastemplestein/.superset/worktrees/iterate/juniper-newsprint/.github/ts-workflows/workflows/cloudflare-previews.ts#L46)
- Why this is a problem:
  The new workflow repeats the full `pnpm preview sync` CLI argument set for fork sync, non-fork sync, and cleanup. That means the single-owner workflow still has a large amount of shell-only contract knowledge. Any future input rename or PR-context change has to be updated in multiple places.
- Option A:
  Add one repo-local preview lifecycle command, for example `pnpm preview sync-pr` / `pnpm preview cleanup-pr`, that owns the PR argument parsing and app loop internally.
- Option B:
  Keep the current per-app procedures, but add a single shell/TS wrapper under `scripts/preview/` so the workflow only calls one entrypoint for sync and one for cleanup.
- Recommendation:
  Option A. It deletes the most YAML, centralizes the interface at the router boundary, and lines up with the repo rule that deployment-machine logic should be an oRPC procedure.

### Low: The per-app deploy workflow generator still carries stale PR-era variable logic

- Rules: "Don't declare constants that are only used once", "Don't put all the variables you need at the top", "find opportunities to delete lots more code"
- Files:
  [.github/ts-workflows/utils/cloudflare-app-workflow.ts](/Users/jonastemplestein/.superset/worktrees/iterate/juniper-newsprint/.github/ts-workflows/utils/cloudflare-app-workflow.ts#L45)
- Why this is a problem:
  After removing `pull_request` handling from the deploy workflows, the `variables` job still computes values as if PR context exists, including `github.event.pull_request.head.sha || github.sha`. That fallback is now dead weight in these workflows.
- Option A:
  Simplify the `variables` job to use `github.sha` directly and remove any outputs that are no longer needed outside deploy + Slack.
- Option B:
  Delete the dedicated `variables` job entirely and inline the now-small expressions into deploy and Slack steps.
- Recommendation:
  Option A now, then Option B if you want to keep deleting workflow scaffolding after the preview lifecycle wrapper exists.

## Open Questions / Assumptions

- No high-severity correctness bug stood out in the reviewed diff.
- The accepted product choice is still that deleting the managed PR body section is state loss, not something the system must recover from.

# Plan (TODO)
