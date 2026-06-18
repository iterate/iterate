---
status: complete
size: medium
branch: codex/project-worker-ts-entrypoint-main
base: codex/os-local-playwright-e2e-main
---

# Project Worker TypeScript Entrypoint

Status summary: Complete. Project workers now use `worker.ts` class entrypoints via `iterate/worker`, seeded/example repos use TypeScript worker files, project-worker examples use the `project-worker` runtime label, and the focused build/typecheck/test pass is green.

## Assumptions

- No backwards compatibility is required. This is experimental and unreleased, so `worker.js` should disappear from project-worker examples and runtime configuration.
- The project worker entrypoint should be `worker.ts`, bundled through the existing repo-source `@cloudflare/worker-bundler` path.
- Project authors should import a small base class from `iterate/worker`, not directly from `cloudflare:workers` for the common project-worker case.
- The platform-facing event hook remains `processEvent`, but author-facing subclass code should use a neater hook name such as `onProjectEvent`.

## Checklist

- [x] Add an `iterate/worker` package export with `IterateProjectEntrypoint` and project-worker env/event types. _Implemented in `packages/iterate/src/worker.ts` with a hand-authored `worker.d.mts` copied during the package build._
- [x] Change the platform project-worker source from `worker.js` to `worker.ts`. _Updated `PROJECT_WORKER_SOURCE` and the repo-source build path to bundle `worker.ts`._
- [x] Update the generated project config repo seed to TypeScript entrypoints and a package dependency/tooling shape that supports `iterate/worker`. _Seed now writes `worker.ts`, app `worker.ts` files, package dev dependencies, and a Cloudflare worker `tsconfig.json`._
- [x] Update the checked-in `apps/os/iterate-config-repo` example to the new TypeScript format. _Renamed the root/app workers to `.ts`, added `tsconfig.json`, and updated authoring notes._
- [x] Update project-worker runtime fixtures and e2e examples that demonstrate project authoring. _The itx e2e catalogue runner and agent customization coverage now use the class entrypoint and `project-worker` runtime label._
- [x] Update public/internal docs that tell users the project worker is `worker.js`. _Updated iterate.com docs, OS project template notes, REPL/runtime docs, and the explainer HTML._
- [x] Run focused tests or typechecks covering the changed runtime surface. _Verified package build, OS typecheck, sample repo typecheck, lint, direct helper compile, and project-ingress tests._

## Implementation Notes

- First commit is intentionally only this task spec, following the project task workflow for branch-based work.
- Recreated from current `main` as replacement PR #1554 after #1544 picked up the accidental #1545 merge commit. This branch is stacked on the recreated #1545 branch so the Playwright PR can merge first.
- Verification run:
  - `pnpm --dir packages/iterate build`
  - `pnpm --dir apps/os exec tsc --noEmit --target esnext --module nodenext --moduleResolution nodenext --lib esnext --types @cloudflare/workers-types --strict --skipLibCheck ../../packages/iterate/src/worker.ts`
  - `pnpm --dir apps/os/iterate-config-repo typecheck`
  - `pnpm --dir apps/os typecheck`
  - `pnpm --dir apps/os exec vitest run src/domains/projects/stream-processors/project/implementation.test.ts src/domains/projects/project-worker-runtime.test.ts`
  - `pnpm lint`
  - `pnpm format:check`
