# Minimal ITX v4 Repos And Project Worker Re-Addition

## Goal

Re-add the repo system and default project worker mechanism to
`apps/minimal-itx-v4` in the simplest shape that stays faithful to the v4
direction:

- `types.ts` is the handcrafted, human-readable public type surface.
- `rpc-targets.ts` is the Cap'n Web / Workers RPC capability tree.
- Durable Objects own durable domain side effects.
- Stream processors project stream facts and trigger small bootstrap effects.
- The full dynamic ITX capability system can stay out of scope for this slice.

This is not a request to copy v3 wholesale. v3 is useful as the reference for
what worked; v4 is the design direction.

## Non-Goals

- Do not change the v4 authentication model in this slice.
- Do not re-add agents.
- Do not re-add `project.runScript`, `provideCapability`, or `revokeCapability`.
- Do not introduce the full `apps/os` ITX chain/defaults architecture.
- Do not make the project worker special in the type layer beyond exposing the
  built-in `project.worker` handle.

## Target Caller Shape

```ts
// EXISTING: callers authenticate to the v4 root capability.
using root = session.authenticate({
  type: "trusted-internal",
  token: TRUSTED_INTERNAL_ITX_TOKEN,
});

// EXISTING: project creation returns a Project capability.
using project = root.projects.create({ slug: "alice-project" });

// NEW: every project gets a default repo at /repos/project.
expect(await project.repo.whoami()).toMatch(/^repo prj_.+:\/repos\/project$/);

// NEW: the same repo is reachable through the collection.
expect(await project.repos.get("/repos/project").whoami()).toEqual(await project.repo.whoami());

// NEW: the project worker loads worker.js from /repos/project.
const response = await project.worker.fetch(new Request("https://example.com/probe"));
expect(await response.text()).toBe("project worker fetched /probe");
```

## Big Picture

The re-addition has four layers:

1. `types.ts`: describe `repos`, `repo`, and `worker` on `Project` in the
   handcrafted public types.
2. `rpc-targets.ts`: add the actual capability-tree adapters that route
   project-scoped repo and worker calls to Durable Object stubs.
3. Durable Objects: enable `RepoDurableObject`; let `ProjectDurableObject` load
   the default project worker through `DynamicWorkersRpcTarget`.
4. Stream processors: make project creation ensure `/repos/project` exists and
   let the repo domain own repo lifecycle facts.

The simplest faithful rule: project creation should guarantee that
`/repos/project` exists and has been seeded before `projects.create()` returns.

## Phase 1: `types.ts`

`types.ts` already contains most of the target types. The main change is to
uncomment the built-ins on `Project` and keep the repo/worker types as the
stable public contract.

```ts
export interface Project extends ItxCapabilityHost {
  streams: Streams; // EXISTING: already active in v4.
  describe(): { projectId: string; name: string }; // EXISTING.

  repos: Repos; // NEW: project-scoped repo collection.
  repo: Repo; // NEW: convenience handle for /repos/project.
  worker: ProjectWorker; // NEW: default worker sourced from project.repo worker.js.

  // NOT IN THIS SLICE:
  // agents: Agents;
}
```

Keep the current repo and worker interfaces small:

```ts
export interface Repo {
  create(): Promise<Repo>; // CHANGED: chainable like Projects.create() -> Project.
  whoami(): string; // EXISTING TYPE: simple e2e proof of routing and identity.
}

export interface Repos {
  create(input: { path: string }): Promise<Repo>; // CHANGED: returns the created Repo handle.
  get(path: string): Repo; // EXISTING TYPE.
}

export interface ProjectWorker {
  fetch(req: Request): Promise<Response>; // EXISTING TYPE.
  processEvent(input: { event: StreamEvent }): void | Promise<void>; // EXISTING TYPE.
}
```

Keep the dynamic-worker source types, but only wire the part needed by
`project.worker`:

```ts
export type DynamicWorkerSource =
  | {
      type: "inline"; // EXISTING: remains useful for later dynamic capabilities.
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo"; // EXISTING TYPE, NEWLY WIRED in DynamicWorkersRpcTarget.
      repoPath: string; // For project.worker this is "/repos/project".
      sourcePath: string; // For project.worker this is "worker.js".
    };
```

### Type-Layer Boundary

Do not add `getWorkerSource()` to the public `Repo` interface. It is an internal
Durable Object method used by the dynamic worker source resolver.

```ts
export interface Repo {
  create(): Promise<Repo>; // CHANGED: public create returns a capability, not the lifecycle event.
  whoami(): string;

  // DO NOT ADD:
  // getWorkerSource(args: { path: string }): Promise<ResolvedWorkerSource>;
  //
  // Reason: callers should not depend on loader internals. The repo domain owns
  // git state; the dynamic worker resolver owns source loading.
}
```

## Phase 2: `rpc-targets.ts`

The v4 pattern is: public capability classes are `RpcTarget` adapters, not the
domain objects themselves. Add repo and worker adapters that mirror
`StreamRpcTarget` and `ProjectRpcTarget`.

```ts
const PROJECT_REPO_PATH = "/repos/project"; // NEW: local constant in rpc-targets.ts.

class RepoRpcTarget extends RpcTarget implements RpcTargetImplementation<Repo> {
  constructor(
    readonly props: {
      auth: ItxAuth; // EXISTING: same auth context ProjectRpcTarget uses.
      projectId: string; // EXISTING: project-scoped capability.
      path: string; // NEW: repo path inside the project, e.g. /repos/project.
    },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId); // EXISTING auth rule.
  }

  get durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    ); // NEW: requires REPO binding in wrangler.jsonc.
  }

  async create() {
    await this.durableObjectStub.create(); // NEW: internal DO method still writes repo lifecycle facts.
    return new RepoRpcTarget(this.props); // CHANGED: public create is chainable and returns Repo.
  }

  whoami() {
    return this.durableObjectStub.whoami(); // NEW: route to RepoDurableObject.
  }
}
```

```ts
class ReposRpcTarget extends RpcTarget implements RpcTargetImplementation<Repos> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId); // EXISTING auth rule.
  }

  get(path: string) {
    return new RepoRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path,
    }); // NEW: collection lookup.
  }

  async create(input: { path: string }) {
    const repo = this.get(input.path); // NEW: create returns the repo capability, like projects.create().
    await repo.create();
    return repo;
  }
}
```

`ProjectWorkerRpcTarget` should stay a thin adapter into the project Durable
Object. The project Durable Object owns the loader because it has `ctx.exports`,
`ctx.facets`, storage, and the project-local trusted `ITX` binding.

```ts
class ProjectWorkerRpcTarget extends RpcTarget implements RpcTargetImplementation<ProjectWorker> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId); // EXISTING auth rule.
  }

  get projectDurableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: "/",
      }),
    ); // EXISTING PROJECT binding, NEW worker methods on the DO.
  }

  fetch(req: Request) {
    return this.projectDurableObjectStub.workerFetch(req); // NEW.
  }

  processEvent(input: { event: StreamEvent }) {
    return this.projectDurableObjectStub.workerProcessEvent(input); // NEW.
  }
}
```

Then `ProjectRpcTarget` exposes the built-ins:

```ts
export class ProjectRpcTarget extends RpcTarget implements RpcTargetImplementation<Project> {
  // EXISTING constructor, durableObjectStub, describe(), streams...

  get repos(): RpcTargetImplementation<Repos> {
    return new ReposRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    }); // NEW.
  }

  get repo(): RpcTargetImplementation<Repo> {
    return this.repos.get(PROJECT_REPO_PATH); // NEW convenience shortcut.
  }

  get worker(): RpcTargetImplementation<ProjectWorker> {
    return new ProjectWorkerRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    }); // NEW.
  }
}
```

## Phase 3: `ProjectDurableObject`

The commented v4 shape is already close. Re-enable only the minimal loader
surface needed for `project.worker`.

```ts
const PROJECT_REPO_PATH = "/repos/project"; // NEW: same semantic constant.

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parseProjectScoped(this.ctx.id.name!); // EXISTING.
  readonly #processorHost = createStreamProcessorHost(this.ctx); // EXISTING.

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: {
          // EXISTING: v4 trusted internal credential shape.
          type: "trusted-internal",
          token: TRUSTED_INTERNAL_ITX_TOKEN,
        },
      }),
    },
    facets: this.ctx.facets, // EXISTING commented shape, NEWLY ENABLED.
    loader: this.env.LOADER, // EXISTING binding, NEWLY USED here.
    projectId: this.#name.projectId,
    storage: this.ctx.storage,
  });

  async workerFetch(req: Request) {
    const worker = await this.#dynamicWorkers.get<ProjectWorker>({
      source: {
        type: "repo", // NEWLY WIRED source kind.
        repoPath: PROJECT_REPO_PATH,
        sourcePath: "worker.js",
      },
      target: { type: "worker-entrypoint" },
    });

    return await worker.fetch(req);
  }

  async workerProcessEvent(input: Parameters<ProjectWorker["processEvent"]>[0]) {
    const worker = await this.#dynamicWorkers.get<ProjectWorker>({
      source: {
        type: "repo", // NEWLY WIRED source kind.
        repoPath: PROJECT_REPO_PATH,
        sourcePath: "worker.js",
      },
      target: { type: "worker-entrypoint" },
    });

    return await worker.processEvent(input);
  }
}
```

Do not re-enable `ItxProcessor` in this slice unless `project.runScript` or
dynamic capability mounting returns. The project worker can load without it.

## Phase 4: `DynamicWorkersRpcTarget`

Keep the current inline-source path. Replace the explicit v4 throw for repo
sources with the v3-style resolver using v4 naming.

```ts
async #resolveSource(source: DynamicWorkerSource): Promise<ResolvedWorkerSource> {
  if (source.type === "inline") {
    return {
      cacheKey: hashString(JSON.stringify(source)),
      mainModule: source.mainModule,
      modules: source.modules,
    }; // EXISTING.
  }

  const repo = env.REPO.getByName(
    DurableObjectNameCodec.stringify({
      projectId: this.#projectId,
      path: source.repoPath,
    }),
  ); // NEW: repo-source resolver needs REPO binding.

  const resolved = await repo.getWorkerSource({ path: source.sourcePath }); // NEW internal DO method.

  return {
    cacheKey: hashString(JSON.stringify({ source, resolved })), // NEW: source-aware loader key.
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  };
}
```

This is intentionally simpler than `apps/os/src/itx/source-build.ts`: v4 can use
the existing `RepoDurableObject.getWorkerSource()` clone/read path before
introducing R2 build memoization.

## Phase 5: `RepoDurableObject`

`RepoDurableObject` already has the important mechanics:

- `create()` appends `repo/create-requested`.
- it creates or opens the Artifact repo.
- it seeds `PROJECT_REPO_INITIAL_FILES`.
- it appends `repo/created`.
- `getWorkerSource()` reads `.js` modules from the repo for Worker Loader.

Minimal changes:

```ts
export class RepoDurableObject extends DurableObject<Env> {
  // CHANGED: this DO no longer needs to implement the public Repo interface
  // if public Repo.create() returns a Repo handle. The DO method remains an
  // internal lifecycle operation that returns the committed repo/created event.

  // EXISTING: parse projectId/path from DO name.
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);

  // EXISTING: stream backing for repo lifecycle facts.
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  async create(): Promise<StreamEvent> {
    const existing = await this.createdEvent();
    if (existing) return existing; // EXISTING INTERNAL SHAPE: idempotent lifecycle event.

    await this.ensureRepoProcessorSubscription(); // NEW: make repo stream own processor setup.

    await this.#streamWriter().append({
      type: "events.iterate.com/repo/create-requested",
      payload: {},
    }); // EXISTING v4 append shape.

    // EXISTING INTERNAL SHAPE: create artifact + seed files + append repo/created.
  }

  private async ensureRepoProcessorSubscription() {
    await this.#streamWriter().append({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `repo-subscription:${this.#name.projectId}:${this.#name.path}`,
      payload: {
        subscriptionKey: RepoProcessorContract.slug,
        subscriber: {
          address: this.#name,
          type: "repo",
        },
      },
    }); // NEW: setup lands on the repo stream, not the project root stream.
  }
}
```

This moves repo processor setup to the repo domain. Project creation only needs
to ask for the project repo to exist.

## Phase 6: Project Creation And Processor Bootstrap

There are two simple options.

### Option A: Direct Ensure In `ProjectsRpcTarget.create()`

After `project/created` is observed, create the default project repo directly:

```ts
await stream.waitForEvent({
  eventTypes: ["events.iterate.com/project/created"],
  timeoutMs: 5000,
}); // EXISTING.

await env.REPO.getByName(
  DurableObjectNameCodec.stringify({
    projectId: args.projectId,
    path: PROJECT_REPO_PATH,
  }),
).create(); // NEW: simple direct guarantee before create() returns.

return new ProjectRpcTarget({ auth: this.props.auth, projectId: args.projectId }); // EXISTING.
```

Pros:

- Most direct.
- Easy to test.
- Keeps repo lifecycle in `RepoDurableObject.create()`.

Cons:

- Project creation orchestration is partly in `rpc-targets.ts`.

### Option B: Project Processor Ensures Repo

On `project/created`, the project processor calls the repo DO:

```ts
case "events.iterate.com/project/created": {
  blockProcessorWhile(async () => {
    await this.deps.env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.deps.projectId,
        path: PROJECT_REPO_PATH,
      }),
    ).create(); // NEW: processor-side project repo bootstrap.
  });
  return;
}
```

Then `ProjectsRpcTarget.create()` waits for a root-stream fact such as:

```ts
{
  type: "events.iterate.com/project/repo-initialized", // NEW event if we want an explicit barrier.
  payload: {
    projectId: args.projectId,
    repoPath: PROJECT_REPO_PATH,
  },
}
```

Pros:

- Project bootstrap side effects live in the project processor.
- Closer to `apps/os`.

Cons:

- Requires a new event and wait barrier to make `projects.create()` guarantee
  the repo exists before returning.

### Recommendation

Start with Option A for this minimal v4 re-addition. It is faithful to the v4
adapter style and avoids over-designing the project processor before the repo
surface exists again. Move to Option B later if we want project creation to be
entirely event-driven.

## Wrangler And Worker Exports

Enable the repo Durable Object binding and export.

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "PROJECT", "class_name": "ProjectDurableObject" }, // EXISTING.
      { "name": "REPO", "class_name": "RepoDurableObject" }, // NEWLY ENABLED.
      { "name": "STREAM", "class_name": "StreamDurableObject" }, // EXISTING.
    ],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "ProjectDurableObject", // EXISTING.
        "RepoDurableObject", // NEWLY ENABLED.
        "StreamDurableObject", // EXISTING.
      ],
    },
  ],
}
```

```ts
import { RepoDurableObject } from "./domains/repos/repo-durable-object.ts"; // NEWLY ENABLED.

export {
  ItxEntrypoint, // EXISTING.
  ProjectDurableObject, // EXISTING.
  RepoDurableObject, // NEWLY ENABLED.
  StreamDurableObject, // EXISTING.
};
```

## Tests To Re-Add First

Re-add only the focused v3 tests that prove this slice.

```ts
test("project creation creates and seeds the default repo", async () => {
  using root = withItxSession().authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  }); // EXISTING auth test style.

  using project = root.projects.create({ slug: `repo-${crypto.randomUUID()}` }); // EXISTING.

  expect(await project.repo.whoami()).toMatch(/:\/repos\/project$/); // NEW.
  expect(await project.repos.get("/repos/project").whoami()).toEqual(await project.repo.whoami()); // NEW.

  const repoEvents = await project.streams.get("/repos/project").getEvents();
  expect(repoEvents.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "events.iterate.com/repo/create-requested", // NEW expected fact.
      "events.iterate.com/repo/created", // NEW expected fact.
    ]),
  );
});
```

```ts
test("project worker fetches from seeded worker.js", async () => {
  using root = withItxSession().authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  }); // EXISTING.

  using project = root.projects.create({ slug: `worker-${crypto.randomUUID()}` }); // EXISTING.

  const response = await project.worker.fetch(new Request("https://example.com/probe")); // NEW.
  expect(await response.text()).toBe("project worker fetched /probe"); // NEW.
});
```

Then add a lower-level repo-source resolver test only if the e2e error surface is
too broad.

## Expected Final File Touches

- `apps/minimal-itx-v4/types.ts`
  - uncomment `Project.repos`, `Project.repo`, and `Project.worker`.
- `apps/minimal-itx-v4/src/rpc-targets.ts`
  - add `PROJECT_REPO_PATH`, `RepoRpcTarget`, `ReposRpcTarget`,
    `ProjectWorkerRpcTarget`.
  - expose `repo`, `repos`, and `worker` on `ProjectRpcTarget`.
  - optionally directly ensure the project repo in `ProjectsRpcTarget.create()`.
- `apps/minimal-itx-v4/src/domains/projects/project-durable-object.ts`
  - re-enable `DynamicWorkersRpcTarget`.
  - add `workerFetch()` and `workerProcessEvent()`.
- `apps/minimal-itx-v4/src/domains/dynamic-workers/dynamic-workers-rpc-target.ts`
  - resolve repo sources through `env.REPO`.
- `apps/minimal-itx-v4/src/domains/repos/repo-durable-object.ts`
  - ensure repo processor subscription on the repo stream before creation.
- `apps/minimal-itx-v4/src/worker.ts`
  - export `RepoDurableObject`.
- `apps/minimal-itx-v4/wrangler.jsonc`
  - enable `REPO` binding and migration class.
- `apps/minimal-itx-v4/itx.e2e.test.ts`
  - re-add focused repo/project-worker tests with v4 append/auth shape.

## Main Open Question

Should `projects.create()` directly ensure `/repos/project` after
`project/created`, or should `ProjectProcessor` emit a `project/repo-initialized`
barrier after calling the repo domain?

The recommended first implementation is direct ensure in `ProjectsRpcTarget`.
It is simpler, testable, and does not compromise the public v4 shape.
