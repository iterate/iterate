---
status: in-progress
size: medium
branch: codex/project-worker-ts-entrypoint
---

# Project Worker TypeScript Entrypoint

Status summary: Spec written; implementation not started yet. The target is a clean break from the old `worker.js` object-literal format to `worker.ts` plus an `iterate/worker` helper export. Missing pieces are the SDK export, project source path/runtime changes, seeded repo/example updates, docs, and verification.

## Assumptions

- No backwards compatibility is required. This is experimental and unreleased, so `worker.js` should disappear from project-worker examples and runtime configuration.
- The project worker entrypoint should be `worker.ts`, bundled through the existing repo-source `@cloudflare/worker-bundler` path.
- Project authors should import a small base class from `iterate/worker`, not directly from `cloudflare:workers` for the common project-worker case.
- The platform-facing event hook remains `processEvent`, but author-facing subclass code should use a neater hook name such as `onProjectEvent`.

## Checklist

- [ ] Add an `iterate/worker` package export with `IterateProjectEntrypoint` and project-worker env/event types.
- [ ] Change the platform project-worker source from `worker.js` to `worker.ts`.
- [ ] Update the generated project config repo seed to TypeScript entrypoints and a package dependency/tooling shape that supports `iterate/worker`.
- [ ] Update the checked-in `apps/os/iterate-config-repo` example to the new TypeScript format.
- [ ] Update project-worker runtime fixtures and e2e examples that demonstrate project authoring.
- [ ] Update public/internal docs that tell users the project worker is `worker.js`.
- [ ] Run focused tests or typechecks covering the changed runtime surface.

## Implementation Notes

- First commit is intentionally only this task spec, following the project task workflow for branch-based work.
