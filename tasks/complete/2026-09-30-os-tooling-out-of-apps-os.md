---
status: done
size: medium
---

# iterate's apps/os tooling moves out of apps/os

Pre-work item 2 for moving apps/os into `core/` (item 1 was envs.ts: iterate/iterate#3447 and
iterate/iterate#3448, `tasks/complete/2026-09-29-os-deployment-config-into-apps-os.md`). Core builds from a clone
of itself; outside code may import core, core never imports outside code.

After iterate/iterate#3448 the apps/os build reaches nothing in envs.ts, but 12 apps/os files still import it. All
but one are iterate's own tooling: deploying prd and main on dev, provisioning, erasing, seeding,
the per-PR previews, soak and load runs. A self-hoster needs none of it. This moves that tooling to
`scripts/os/`, next to the rest of iterate's scripts.

Status: done: merged as iterate/iterate#3456.

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

- [x] `git mv` the files above; every relative import and every `import.meta` path that meant
      "apps/os" names apps/os explicitly _imports rewritten by resolving each specifier; `ROOT`,
      `APP_ROOT` and `appRoot` point at apps/os; the soak runs `pnpm preview` from the root_
- [x] commands: apps/os/package.json loses `deploy`, `preview`, `ensure-resources`, `erase-data`,
      `control-plane-load`, `project-seed`, `seed-instance-secrets`, `e2e:soak`. Root package.json
      gets `preview` (same name, so `pnpm preview deploy` still works) and `os:deploy`,
      `os:ensure-resources`, `os:erase-data`, `os:control-plane-load`, `os:project-seed`,
      `os:seed-instance-secrets`, `os:e2e-soak` _each smoke-run with `--help` from the root_
- [x] workflows: those steps run from the repo root (no `working-directory: apps/os`) _17 steps
      in 9 workflows, each a single command; deploy-os runs `pnpm os:deploy --env prd`_
- [x] CI triggers: scripts/ci/preview-paths.ts `previewPaths` gains `scripts/os/**`; deploy-os.yml's
      `paths` gain `scripts/os/**` with the exclusions it has today for the preview and soak scripts
      and tests _plus the three workflows that copy previewPaths_
- [x] dependencies: scripts/package.json gains what the moved files import from npm (`iterate`,
      `capnweb`, `undici`)
- [x] typecheck and tests: the moved tests run in the scripts workspace; apps/os's scripts tsconfig
      and unit project no longer see them _project-seed.ts imports worker code, so it typechecks
      with Workers types through scripts/os/tsconfig.project-seed.json_
- [x] knip, docs, AGENTS.md files and comments name the new paths and commands _comments in the
      moved files name apps/os files as apps/os/…_
- [x] a test lists every apps/os file that imports envs.ts: only e2e/support/deployed-target.ts
      _apps/os/scripts/build.test.ts lists every import from outside apps/os and packages/;
      generate-wrangler-config.test.ts uses its own deployment, and iterate's deployments' resource
      names moved to scripts/os/preview.test.ts_

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

- What apps/os still imports from outside apps/os and packages/ (build.test.ts): envs.ts from
  e2e/support/deployed-target.ts; scripts/lib/vite-build.ts and wrangler-config.ts (self-contained);
  the dummy pet shop's state from three Workers tests; configs/default and configs/heartbeat from the
  template test.
- Local: lint, oxfmt, `pnpm typecheck`, knip, apps/os unit + Workers (139 files) and the scripts
  workspace pass. The scripts workspace's toolchain and tracing tests fail on macOS's bash 3.2 (no
  `inherit_errexit`) on main too; specs-shards failed once under a full parallel run and passes alone.
