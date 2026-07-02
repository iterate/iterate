# CI Workflows

This repo has two CI surfaces:

- Normal CI lives in GitHub Actions and is generated from TypeScript.
- One Depot CI workflow exists only to bake the optional preview runner image.

For normal workflow changes, use the TypeScript generator. Do not edit generated
GitHub workflow YAML by hand.

## Normal GitHub Actions

Workflow sources live in `.github/ts-workflows/workflows/*.ts`.

Generated workflow YAML lives in `.github/workflows/*.yml`.

To change a normal CI workflow:

```bash
pnpm workflows
pnpm --dir .github/ts-workflows build
```

Commit both the TypeScript source and generated YAML. The generator compares the
TypeScript workflow object with the checked-in YAML, and CI fails if they drift.

Useful entry points:

- `.github/ts-workflows/workflows/cloudflare-previews.ts` controls the preview
  deploy/e2e GitHub Actions workflow.
- `.github/ts-workflows/utils/index.ts` contains shared runner/setup helpers.
- `.github/workflows/cloudflare-previews.yml` is generated output.

### Preview Deploy And Test Model

The preview workflow is deliberately simple:

- select the apps affected by the PR diff;
- include declared preview dependencies, currently OS -> auth;
- deploy the selected apps in one parallel batch;
- after deployment has finished, run tests for deployed apps one at a time.

The preview script does not try to prove dependency freshness or start each app's
tests as soon as it is individually ready. That lost little in the measured case
and keeps the behavior easy to reason about. OS bakes auth JWKS during
deployment; its deploy-time JWKS fetch polls the slot's auth worker until it
responds, so the OS deploy no longer waits for the auth deploy to finish first.

To run the same deploy-then-test lifecycle from your machine:

```bash
doppler run --project _shared --config prd -- pnpm preview:ci <pr-number>
```

That wrapper lives at `scripts/preview/run-ci-locally.sh`. It uses
`GITHUB_TOKEN` or `gh auth token`, sets the workflow URL to the PR URL for local
runs, then runs the same two preview commands as the GitHub workflow:

```bash
pnpm preview deploy ...
pnpm preview test ...
```

Use this when you want to reproduce the preview deployment and e2e behavior
without waiting for GitHub Actions. The preview CLI intentionally keeps deploy
and test as separate commands so the CI shape and local reproduction path match.

## Depot GitHub Actions Runners

Most workflows still run on GitHub Actions. Depot is used there as a runner
provider by setting `runs-on` to a Depot runner label, for example:

```yaml
runs-on: depot-ubuntu-24.04
```

This is still GitHub Actions. It uses GitHub workflow triggers, GitHub secrets,
GitHub checks, and the `.github/workflows` files.

Depot runner docs:

- [Depot GitHub Actions runners](https://depot.dev/docs/github-actions/overview)
- [Runner types](https://depot.dev/docs/github-actions/runner-types)

## Depot CI

Depot CI is Depot's own CI control plane. Its workflows live in
`.depot/workflows`.

Depot's migration docs describe this split: `depot ci migrate` discovers
`.github/workflows` and copies selected workflows into `.depot/workflows`.

Depot CI docs:

- [Depot CI quickstart](https://depot.dev/docs/ci/quickstart)
- [Depot CI CLI reference](https://depot.dev/docs/cli/reference/depot-ci)
- [Manage Depot CI workflow runs](https://depot.dev/docs/ci/how-to-guides/manage-workflow-runs)

This repo intentionally does not migrate the main workflows to Depot CI right
now. Normal CI remains the generated GitHub Actions setup above.

## The One Depot CI Workflow

The only checked-in Depot CI workflow is:

```text
.depot/workflows/build-preview-ci-image.yml
```

It exists because Depot custom images are a Depot CI feature. The workflow uses
`depot/snapshot-action@v1`, and Depot documents that action as only compatible
with Depot CI, not GitHub Actions.

Custom image docs:

- [Build and use custom images](https://depot.dev/docs/ci/how-to-guides/custom-images)

The image bake workflow:

- runs daily at `04:17 UTC`;
- can be run manually from Depot;
- can be run locally through the Depot CLI;
- calls `scripts/depot-ci/bake-preview-ci-image.sh`;
- snapshots the resulting sandbox to
  `0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree`.

Run it against your local checkout:

```bash
depot ci run \
  --org 0p91s0lz49 \
  --workflow .depot/workflows/build-preview-ci-image.yml \
  --job build-image
```

Run the checked-in workflow on a branch through Depot CI:

```bash
depot ci dispatch \
  --org 0p91s0lz49 \
  --repo iterate/iterate \
  --workflow build-preview-ci-image.yml \
  --ref main
```

Check runs:

```bash
depot ci run list --org 0p91s0lz49 --repo iterate/iterate
depot ci status <run-id> --org 0p91s0lz49
depot ci logs <attempt-id> --org 0p91s0lz49
```

Cancel a run:

```bash
depot ci cancel <run-id> --org 0p91s0lz49
```

## Image Bake Script

The bake script is:

```text
scripts/depot-ci/bake-preview-ci-image.sh
```

It is a plain shell script so the image contents can be tested outside the YAML
workflow in a compatible Linux/Depot sandbox. It expects Node and npm to already
exist because the workflow uses `actions/setup-node` first.

It installs:

- pnpm `10.24.0`;
- workspace dependencies with `pnpm install`;
- Node/pnpm onto a stable system path;
- Doppler CLI;
- the Chromium browser used by the streams preview Playwright smoke.

The bake uses the local runner pnpm store at `/home/runner/.pnpm-store`. A
durable Depot cache disk was tested for the bake, but it made `pnpm install`
much slower while materializing `node_modules`. Keep the bake on the local
store unless new measurements show otherwise.

## Current Decision

The main preview workflow stays on GitHub Actions with Depot runners.

Measurements from this PR:

| Measurement                                      |                                Result |
| ------------------------------------------------ | ------------------------------------: |
| Stock Depot CI runner cold start                 |              about `7s` to first step |
| Custom image cold start                          |        `21-28s` cold, about `7s` warm |
| Preview image bake                               |                               `2m49s` |
| Full custom-image setup trial                    |                               `2m40s` |
| `pnpm install` inside custom setup trial         | `1m1.6s` despite `Already up to date` |
| Latest normal GitHub preview check after cleanup |                                 `50s` |

Conclusion: Depot CI startup is fast, and custom images are useful to keep
available, but the current custom-image consumer path does not beat the normal
GitHub Actions preview workflow. The image bake stays as a narrow, scheduled
Depot CI workflow; the main CI system remains generated GitHub Actions.
