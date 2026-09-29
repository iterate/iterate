---
status: in-progress
size: medium
---

# iterate's apps/os tooling moves out of apps/os

Pre-work item 2 for moving apps/os into `core/` (item 1 was envs.ts: iterate/iterate#3447 and
#3448, `tasks/complete/2026-09-29-os-deployment-config-into-apps-os.md`). Core builds from a clone
of itself; outside code may import core, core never imports outside code.

After #3448 the apps/os build reaches nothing in envs.ts, but 12 apps/os files still import it. All
but one are iterate's own tooling: deploying prd and main on dev, provisioning, erasing, seeding,
the per-PR previews, soak and load runs. A self-hoster needs none of it. This moves that tooling to
`scripts/os/`, next to the rest of iterate's scripts.

Status: spec written, implementation not started.

## What moves (apps/os/scripts → scripts/os)

deploy, ensure-resources, erase-data, d1, preview, preview-config, preview-delete,
preview-readiness, preview-sweep, preview-artifacts, slow-rows, e2e-soak, control-plane-load,
project-seed, seed-instance-secrets, and their tests.

## What stays in apps/os/scripts

- build, dev, getin, generate-wrangler-config, os-env, published-package-commit: the build and
  local dev.
- project-seed-format: the seed format itself, which a Workers test uses; project-seed (the CLI)
  imports it from apps/os.
- preview-{slack,google,x,cloudflare,github}-app: the pet shop fakes the generator builds a
  `petshopOrigin` deployment's integrations from. deploy.ts imports the GitHub one from apps/os.

## Checklist

- [ ] `git mv` the files above; every relative import and every `import.meta` path that meant
      "apps/os" names apps/os explicitly
- [ ] commands: apps/os/package.json loses `deploy`, `preview`, `ensure-resources`, `erase-data`,
      `control-plane-load`, `project-seed`, `seed-instance-secrets`, `e2e:soak`. Root package.json
      gets `preview` (same name, so `pnpm preview deploy` still works) and `os:deploy`,
      `os:ensure-resources`, `os:erase-data`, `os:control-plane-load`, `os:project-seed`,
      `os:seed-instance-secrets`, `os:e2e-soak`
- [ ] workflows: those steps run from the repo root (no `working-directory: apps/os`)
- [ ] CI triggers: scripts/ci/preview-paths.ts `previewPaths` gains `scripts/os/**`; deploy-os.yml's
      `paths` gain `scripts/os/**` with the exclusions it has today for the preview and soak scripts
      and tests
- [ ] dependencies: scripts/package.json gains what the moved files import from npm (`iterate`,
      `capnweb`, `undici`)
- [ ] typecheck and tests: the moved tests run in the scripts workspace; apps/os's scripts tsconfig
      and unit project no longer see them
- [ ] knip, docs, AGENTS.md files and comments name the new paths and commands
- [ ] a test lists every apps/os file that imports envs.ts: only e2e/support/deployed-target.ts

## Assumptions (made without asking)

- One folder, `scripts/os/`, not `scripts/os/` + `scripts/preview/`: deploy, d1, erase-data,
  preview-artifacts and preview import each other both ways. Splitting later is cheap.
- File names stay as they are (preview-artifacts is also prd deploy's), so the diff is moves.
- Root scripts get an `os:` prefix because `pnpm deploy` is pnpm's own command; `preview` keeps its
  name because CI and the docs already say `pnpm preview …`.

## Out of scope

- apps/os/e2e/support/deployed-target.ts (the e2e suite finding a deployment by name): the
  "deployment-run tests" item.
- packages/shared and packages/ui (pre-work items 3 and 4).

## Implementation notes
