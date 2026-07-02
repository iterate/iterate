# Dynamic Worker Build Requirements

Status: draft for design review.

## Goal

Bring back multi-file TypeScript dynamic workers in the refactored `apps/os`
itx stack without restoring the pre-itx-v4 implementation wholesale. The system should
let a worker source be represented as a set of files, build those files through
Cloudflare's dynamic worker bundler, store the build output outside the event
log, and load the result through the existing Worker Loader path.

This is not only for the default project worker. The same build model should
make worker-backed provided capabilities easy: a caller can provide a short
TypeScript entry file, a `package.json`, supporting files, and Cloudflare
bundler options, then mount the resulting WorkerEntrypoint or Durable Object as
an ITX capability.

## Current Shape

Dynamic workers are currently recipes passed to `project.workers.get(ref)` or
stored indirectly in durable stream facts:

- ITX capability mounts store `itx-expression` records that can call
  `workers.get(workerRef)`.
- Stream subscriptions may store `{ type: "worker", workerRef }` as a configured
  subscriber.
- `project.worker` is a convenience alias for a default repo-backed stateless
  worker.
- `StatefulWorkerDurableObject` hosts stateful dynamic worker facets, but there
  is no worker stream processor today.
- Repo-backed source materialization is currently a Repo DO projection of a
  single JavaScript file.

## Desired Model

Separate source selection from build execution.

File source answers: where do the source files come from?

- Repo source: files are read from a Git artifact at a branch or commit.
- Inline source: files are provided directly by the caller.

Build execution answers: how do source files become Worker Loader modules?

- Use `@cloudflare/worker-bundler` and its `createWorker()` API.
- Treat the public build options as Cloudflare's `CreateWorkerOptions` without
  `files`; files are supplied by the selected file source.
- Keep `entryPoint` in the build input. It is a first-class bundler option and
  should not be renamed or duplicated as `sourcePath`.
- Prefer one materialization path for all dynamic workers. A single-file
  JavaScript worker is still passed through `createWorker()`. Expose
  Cloudflare's options as-is, including `bundle: false`; the invariant is one
  materialization pipeline, not necessarily one bundled output file.

`DynamicWorkerRef.source` should move to this orthogonal model instead of
preserving the current `inline | repo` source union as the target API. The old
shape can be accepted temporarily by a compatibility parser, but the durable
recipe should clearly say: here is the file source, and here are the
Cloudflare-compatible build options.

## File Source Requirements

Repo file sources must be able to limit the files included in a build snapshot,
so large repos do not become build inputs by default. The exact pattern language
should be include and exclude glob patterns. This keeps repo snapshots bounded
without requiring callers to enumerate the full dependency graph by hand.

Inline file sources are a first-class use case, especially for worker-backed
provided capabilities. A capability provider should be able to pass a small file
map such as `worker.ts`, `package.json`, and a helper module, then rely on the
same bundler/build pipeline as repo-backed workers.

Do not specify inline file size limits in this design pass.

Open shape:

```ts
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
```

## Build Input Requirements

The build input should stay close to Cloudflare's API instead of inventing a
parallel option language.

```ts
import type { CreateWorkerOptions } from "@cloudflare/worker-bundler";

type WorkerBuildOptions = Omit<CreateWorkerOptions, "files">;

type WorkerBuildRequest = {
  source: WorkerFileSource;
  options: WorkerBuildOptions;
};
```

The implementation resolves `source` to files, then calls:

```ts
await createWorker({
  ...request.options,
  files,
});
```

## Stream Processor Requirements

Introduce a worker build stream processor rather than placing build events on the
repo processor. The processor should run anywhere dynamic ITX work can happen,
including project and agent paths.

Worker build lifecycle belongs to the same ITX scope path as the dynamic worker.
This should reuse `DynamicWorkerRef.path`: that path already scopes the worker's
`env.ITX` binding and stateful worker identity, and it should also be the stream
where the worker emits build lifecycle events.

The worker build processor should be a dependency of the ITX processor. Any
stream that gets an ITX processor should also get a worker build processor
subscription. Do not lazily attach it only after the first dynamic worker build;
ITX scopes are the runtime contexts where dynamic workers execute, so build
coordination is part of that standard scope machinery.

The worker build processor owns build lifecycle events such as:

- `events.iterate.com/worker-build/requested`
- `events.iterate.com/worker-build/completed`
- `events.iterate.com/worker-build/failed`

These events record build identity and status, not built module contents. Repo
file source events must not contain expanded repo file contents; the repo file
source is resolved by the build processor. Inline file source events may contain
the caller-provided file map by design, especially for worker-backed provided
capabilities. Inline file size limits are out of scope for this requirements
pass.

## Build Output Requirements

The output of a build must be stored outside the stream event log, behind a
`WorkerBuildArtifactStore` abstraction. The first production implementation
should be a KV-backed build artifact cache.

The artifact store should persist loader-ready build output:

- `mainModule`
- `modules`
- build metadata needed by Worker Loader, such as compatibility date and flags

The build key should be deterministic from the normalized source snapshot,
Cloudflare `CreateWorkerOptions`, bundler/runtime version inputs, compatibility
settings, and the artifact schema version. If the same input is requested again,
the processor should check KV for the completed artifact before rebuilding.

KV is a good fit for the primary cache because artifacts are content-addressed
and immutable: the system writes each build key once, then reads it by exact key.
That avoids the problematic KV pattern of repeatedly updating the same key. KV
also supports expiring entries through `expirationTtl`, so build artifacts can
be cached without needing a separate cleanup worker. R2 remains a possible later
escape hatch for oversized artifacts or archival storage, but it should not be
the default requirement.

Recommended KV layout:

- `worker-build/v1/<buildKey>/manifest.json`
- `worker-build/v1/<buildKey>/modules/<encodedModuleName>`

The manifest is the presence marker. It should include `mainModule`, module key
list, module hashes or sizes, compatibility date and flags, bundler/runtime
version inputs, artifact schema version, and any other metadata needed to load
or audit the build. Module keys should be written first; the manifest should be
written last. If a manifest exists but one of its module keys is missing, the
artifact should be treated as a cache miss and rebuilt from the deterministic
input.

Prefix listing is acceptable as a recovery or diagnostic path, but runtime loads
should prefer the manifest's explicit module key list. KV `list({ prefix })`
supports prefix filtering but is paginated, and using the manifest avoids
depending on list completeness or ordering in the hot path.

The event log should store only enough information to find and audit the output:

- build id or cache key
- source identity
- build options hash
- artifact key
- `mainModule`
- module path list, not module contents
- compatibility date and flags
- error details for failed builds

## Template Requirements

The project repo template should be a real folder of files, not TypeScript string
literals. It should typecheck as a worker project under `apps/os`, and codegen
should generate the seeded repo file map from that folder.

Out-of-sync generated seed code should be a fixable lint error.

## Open Questions

Resolved: worker build events live on the ITX scope stream named by
`DynamicWorkerRef.path`. The repo path is only a file source, not the build event
owner.

Resolved: the worker build processor is installed alongside the ITX processor
for every ITX scope, rather than lazily per first build.

Resolved: the target `DynamicWorkerRef.source` shape should be the orthogonal
file-source plus build-options model. The current `inline | repo` union is
legacy/migration surface, not the desired durable representation.

Resolved: inline file sources are allowed in durable build events and are a
first-class path for worker-backed provided capabilities. Size limits are out of
scope for this requirements pass.

Resolved: expose Cloudflare's `bundle?: boolean` option as-is. `bundle: false`
is allowed; OS should still call `createWorker()` for materialization.

Resolved: repo file source masks use include/exclude glob patterns. Typical
default for a project worker should include the entrypoint, app/source folders,
`package.json`, and `tsconfig.json`, while excluding `.git/**`, `node_modules/**`,
and generated output directories.

Resolved: build output storage uses a `WorkerBuildArtifactStore` abstraction.
The first production target is a KV-backed cache with content-addressed,
immutable artifacts and TTL-based expiration. DO or in-memory storage is
acceptable for local dev and tests behind the same interface. R2 is a later
escape hatch for oversized artifacts or archival storage.
