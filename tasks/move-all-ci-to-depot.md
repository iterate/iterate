---
state: todo
priority: high
size: large
tags: [ci, depot, infra, docs]
---

# Move all Depot-compatible CI workflows to Depot CI (needs Doppler-in-image)

Preview deploy/e2e/cleanup already runs on Depot CI. Move the rest of the
generated workflows too, for the same ~7s pickup vs GitHub's 20s-3m39s. The
mechanism + the one-secret design are worked out below; the blocker is
operational (Doppler baked into the Depot image + validating prod deploys),
which is why it wasn't rushed into the faster-ci PR.

## One secret: DOPPLER_TOKEN (design is proven)

Depot needs exactly one secret, `DOPPLER_TOKEN`, because everything else is in
Doppler (`_shared/prd`) and the code already sources it from there:

- deploy-\*/deploy/test run under `doppler run` → Cloudflare/Alchemy/etc. injected.
- `utils/slack.ts` `getSlackBotToken()` already falls back to
  `doppler secrets --config prd get SLACK_CI_BOT_TOKEN` when the GitHub secret
  is absent (which it is on Depot).
- The only direct `${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}` users (nag,
  pr-dashboard, release, preview) can source it from Doppler the same way —
  it resolves via `doppler secrets --project _shared --config prd get --plain
ITERATE_BOT_GITHUB_TOKEN`.

Verified 2026-07-02: both SLACK_CI_BOT_TOKEN and ITERATE_BOT_GITHUB_TOKEN
resolve from Doppler `_shared/prd`.

## Doppler belongs in the image, not a per-run install

Do NOT `curl | sh` the Doppler CLI in each workflow. Bake Doppler into the
Depot CI runner image (extend the existing `build-preview-ci-image.yml` bake,
which already installs Doppler + pnpm + node_modules, and wire the Depot CI
workflows to use that snapshot as their base — see
depot.dev/docs/ci/how-to-guides/custom-images), then drop the per-workflow
`installDopplerCli` steps. This is the operational prerequisite for the move.

## The generator routing (implement then)

`.github/ts-workflows/cli.ts` generates ts → `.github/workflows/`. Add a
`DEPOT_WORKFLOW_NAMES` set and route those names' yaml to `.depot/workflows/`
(read/write/clean-up the right dir per workflow; delete the stale `.github`
copy on move). Everything Depot-trigger-compatible moves; the exceptions stay
on GitHub Actions:

- `claude-assistant` — `issue_comment`/`issues`/`pull_request_review_comment`
  triggers are unsupported by Depot CI. (`pull_request_review` IS supported.)
- `generate-workflows` — the self-referential generator guardian.

(A working draft of this routing was prototyped in the faster-ci branch and
reverted pending the Doppler-in-image work.)

## Cutover checklist

1. Bake Doppler into the Depot CI image; wire workflows to it; drop per-run
   Doppler installs.
2. Refactor nag/pr-dashboard/release/preview to source ITERATE_BOT_GITHUB_TOKEN
   from Doppler.
3. Flip the workflows into `DEPOT_WORKFLOW_NAMES`, regenerate.
4. Set Depot's `DOPPLER_TOKEN` to the real CI Doppler service token (scoped
   `_shared/prd`) — replaces the interim personal token — then
   `depot ci secrets remove ITERATE_BOT_GITHUB_TOKEN`.
5. **Validate prod deploys on Depot deliberately** (high blast radius) before
   relying on them — dispatch each deploy-\* on a branch first.
6. Confirm branch-protection required-check names still match (Depot GitHub
   App reports the same names).

See docs/depot-ci.md for the usage/command reference.
