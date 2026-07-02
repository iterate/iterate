---
state: todo
priority: high
size: large
tags: [os, itx, workers, dynamic-workers, codegen]
---

# Bring back multi-file TypeScript dynamic worker builds

`apps/os` currently treats dynamic worker source as either inline loader-ready
modules or a repo-backed single JavaScript file projection. Bring back the useful
parts of the old multi-file TypeScript source-build machinery in the refactored
OS itx stack, without restoring the pre-itx-v4 implementation wholesale.

The target design is: a dynamic worker ref names a file source plus
Cloudflare-compatible build options; a worker build stream processor resolves
that source, builds it through Cloudflare's worker bundler, stores loader-ready
output in a KV-backed artifact cache, and the existing Worker Loader path loads
the result.

Background doc: `apps/os/docs/dynamic-worker-build-requirements.md`.

## Current state

- Dynamic workers are currently recipes used by `itx.workers.get(ref)`,
  `project.worker`, stream subscribers, `runScript()`, and worker-backed ITX
  capabilities.
- Current `DynamicWorkerSource` is a legacy `inline | repo` union where inline
  means loader-ready `{ mainModule, modules }`, and repo means one repo file.
- Repo-backed source materialization currently lives in the repo domain and
  produces a single-file Worker Loader projection.
- There is no dynamic worker build stream processor today.
- `StatefulWorkerDurableObject` hosts stateful worker facets, but it is not a
  build processor.
- Current ITX stream events relevant to dynamic workers are indirect:
  `itx/capability-provided`, `itx/capability-revoked`,
  `itx/script-execution-requested`, `itx/script-execution-completed`, and
  `stream/subscription-configured`.

## Requirements

- Use `@cloudflare/worker-bundler` and its `createWorker()` API for
  materialization.
- Expose Cloudflare's `CreateWorkerOptions` as directly as possible, minus
  `files`, because OS supplies files from the selected file source.
- Keep `entryPoint` as the bundler option name; do not rename it to
  `sourcePath`.
- Allow `bundle: false`. The invariant is one OS materialization pipeline
  through `createWorker()`, not necessarily one bundled output file.
- Replace the target durable source shape with an orthogonal file-source plus
  build-options model. The current `inline | repo` shape can be accepted as
  compatibility input during migration.
- Support repo file sources from a Git branch or commit.
- Support repo include/exclude glob masks so the build snapshot does not default
  to the whole repo.
- Support inline file sources as first-class input. This is required for
  worker-backed provided capabilities where a caller supplies a short TypeScript
  file, optional helpers, a `package.json`, and bundling options.
- Do not set inline file size limits in this task. Leave limits for a later
  product/platform constraint pass.
- Build output must not be stored in the stream event log.
- Store build output behind a `WorkerBuildArtifactStore` abstraction.
- First production artifact store should be KV-backed, content-addressed, and
  TTL-expiring.
- R2 is only a later escape hatch for oversized artifacts or archival storage.
- Runtime loads should read a manifest that names exact module keys; prefix
  listing is acceptable for diagnostics or recovery, not the hot path.
- Out-of-sync generated template code should be a fixable lint error through the
  repo's existing `eslint-plugin-codegen`/oxlint setup.
- The repo template should live as a real folder and typecheck under `apps/os`,
  rather than living as string literals in
  `apps/os/src/domains/repos/project-repo-template.ts`.

## Proposed types

Sketch only; final names should follow surrounding `apps/os` conventions.

```ts
import type { CreateWorkerOptions } from "@cloudflare/worker-bundler";

type WorkerFileSource =
  | {
      type: "repo";
      repoPath: string;
      ref: { branch: string } | { commitOid: string };
      include?: string[];
      exclude?: string[];
    }
  | {
      type: "inline";
      files: Record<string, string>;
    };

type WorkerBuildOptions = Omit<CreateWorkerOptions, "files">;

type WorkerBuildRequest = {
  source: WorkerFileSource;
  options: WorkerBuildOptions;
};
```

The implementation resolves `source` to a `files` object and calls:

```ts
await createWorker({
  ...request.options,
  files,
});
```

## Stream processor shape

Add a worker build stream processor. Do not put build lifecycle on the repo
processor: repos are only one source of files.

The worker build processor should be installed wherever the ITX processor is
installed. Any scope that can run ITX dynamic work should also have this build
processor subscribed.

Build lifecycle belongs on the stream named by `DynamicWorkerRef.path`. That
path already scopes the worker's `env.ITX` binding and stateful worker identity,
so it should also be where build lifecycle events are emitted and observed.

Proposed events:

- `events.iterate.com/worker-build/requested`
- `events.iterate.com/worker-build/completed`
- `events.iterate.com/worker-build/failed`

Repo-source build events should contain source identity, masks, options hash,
and build key, not expanded repo file contents. Inline-source build events may
contain the provided file map by design.

Completed events should contain artifact identity and audit metadata, not module
contents.

## KV artifact cache

Build keys should be deterministic from:

- normalized source snapshot
- Cloudflare `CreateWorkerOptions`
- bundler/runtime version inputs
- compatibility date and flags
- artifact schema version

Recommended KV layout:

- `worker-build/v1/<buildKey>/manifest.json`
- `worker-build/v1/<buildKey>/modules/<encodedModuleName>`

The manifest is the presence marker. Write module keys first, then write the
manifest last. If a manifest exists but a listed module is missing, treat the
artifact as a cache miss and rebuild from the deterministic input.

Use `expirationTtl` for artifact cache expiry. KV value size is a practical
constraint for this first implementation; handle larger outputs later rather
than designing R2 into the first pass.

## Runtime behavior

Recommended default: `workers.get(ref)` and worker-backed capability invocation
should build on demand.

On load:

1. Compute the deterministic build key from the worker source and build options.
2. Check KV for the artifact manifest.
3. If present and complete, read modules and call Worker Loader as today.
4. If missing, append `worker-build/requested` on `DynamicWorkerRef.path`.
5. Wait for matching `worker-build/completed` or `worker-build/failed`.
6. On success, load the artifact through Worker Loader.
7. On failure, throw a build error to the original caller.

Concurrent callers should converge on the same build key. Build requests should
be idempotent or deduped by the processor/reducer so one missing artifact does
not trigger unbounded duplicate builds.

## Template/codegen work

Move the default repo template out of
`apps/os/src/domains/repos/project-repo-template.ts` into a real folder, likely
under `apps/os`.

That folder should be typechecked as a worker project. The important part is
that template worker code imports the same capability/types surface a real
project worker would import, and type errors in the template fail `apps/os`
typecheck.

Use the existing repo lint-codegen path:

- root `lint` runs oxlint
- `.oxlintrc.json` enables JS plugins
- `eslint-plugin-codegen` is already installed
- stale generated blocks can be reported and fixed by lint

Generate the seeded repo file map from the real template folder. If the folder
and generated map drift, lint should report a fixable error.

## Implementation broad strokes

1. Add worker build source/build/artifact schemas and TypeScript types near the
   current worker domain types.
2. Add `WorkerBuildArtifactStore` with a KV implementation and in-memory test
   implementation.
3. Add deterministic build-key normalization and hashing for inline and repo
   file sources.
4. Teach the repo domain to resolve a masked file snapshot from a branch or
   commit, rather than only projecting one source file.
5. Add a worker build processor contract and implementation.
6. Wire the worker build processor into ITX processor installation for project
   and agent scopes.
7. Replace `resolveWorkerSource(...)` with a build-aware resolver that returns
   loader-ready `{ cacheKey, mainModule, modules }`.
8. Preserve compatibility for current inline loader-ready module refs and
   single-file repo refs during migration.
9. Move the default repo template to a real folder and add codegen to generate
   `project-repo-template.ts` or its replacement.
10. Add focused tests for build-key determinism, KV manifest behavior, processor
    dedupe, inline capability builds, repo masked builds, Worker Loader
    integration, and template codegen drift.

## Open questions for the implementer

- Should the build-on-demand path block `workers.get(ref)` itself, or should
  `workers.get(ref)` return a lazy capability whose first method call blocks?
  Recommended default: block during resolution so errors are clear and the
  existing loader path stays simple.
- What timeout should callers use while waiting for a build completion event?
  Recommended default: start with a conservative platform timeout and make it
  explicit in errors.
- How should stale in-progress builds be retried after an isolate crash or
  processor failure? Recommended default: request events are idempotent by
  build key, and a later caller can re-request after an age threshold if no
  terminal event exists and KV still misses.
- What exact include/exclude defaults should project workers get? Recommended
  default: include the entrypoint, source/app folders, `package.json`, and
  `tsconfig.json`; exclude `.git/**`, `node_modules/**`, build output, and
  generated cache directories.
- Should branch-backed repo sources be late-bound or resolved to a commit at
  request time? Recommended default: resolve branch to commit during build-key
  computation so the build artifact is immutable and auditable.
- Which bundler/runtime version inputs belong in the build key? Recommended
  default: include `@cloudflare/worker-bundler` package version, artifact schema
  version, OS build/runtime version, compatibility date, compatibility flags,
  and relevant `CreateWorkerOptions`.
- How should package registry/network failures be surfaced? Recommended
  default: `worker-build/failed` should include a sanitized error message and
  structured phase, such as `resolve-source`, `bundle`, or `store-artifact`.
- Should KV artifact TTL be fixed globally or configurable by environment?
  Recommended default: make it an environment config with a safe default.
- How much of the old main-branch `apps/os/src/itx/source-build.ts` should be
  reused? Recommended default: use it as a reference for Cloudflare bundler
  integration and loader-ready output shape, but rewrite around the refactored
  worker domain and stream processor model.

## Acceptance criteria

- Multi-file TypeScript dynamic workers can be built from inline file maps.
- Multi-file TypeScript dynamic workers can be built from masked repo file
  snapshots.
- Worker-backed provided capabilities can use the same build pipeline.
- The default project worker template lives in a real typechecked folder.
- Generated seeded repo template code is kept in sync by a fixable lint rule.
- Build output is cached in KV by deterministic build key and loaded through the
  existing Worker Loader path.
- Build lifecycle is visible as worker-build events on `DynamicWorkerRef.path`.
- Stream events do not contain built module contents.
- Existing single-file inline/repo dynamic workers continue to work during
  migration.
