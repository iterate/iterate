# Cap'n Web Capabilities

This folder owns the Cap'n Web / Workers RPC capability model for OS runtime
APIs.

The design goal is a single scoped capability tree that can be used from:

- Node Vitest e2e sessions over Cap'n Web WebSockets.
- `/api/captnweb/run` dynamic workers.
- Project iterate-config dynamic workers.
- Codemode-shaped scripts and future developer scripts.

The same authoring model should work everywhere:

```ts
using project = await ctx.project;
using workspace = await project.workspace;
using git = await workspace.git;
await git.add({ dir, filepath: "worker.js" });
await git.push({ dir, remote: "origin", ref });

using worker = await project.worker;
await worker.someTool({ value: 1 });
```

## Entrypoints

`/api/captnweb`
: Root Cap'n Web session. Authenticated with the root API secret. Returns an
`IterateContext` with `scopes: { projects: "all" }`.

`/api/captnweb/run`
: JSON bridge for e2e/codemode-shaped scripts. The parent worker creates a
dynamic worker with `env.ITERATE`, the dynamic worker resolves
`await env.ITERATE.context`, runs the provided function with
`{ ctx, env, vars }`, and returns JSON. Results must be serializable.

`/__iterate/capnweb`
: Project ingress Cap'n Web session. Returns the project capability directly.
Call `project.getIterateContext()` when you want the project-scoped
`IterateContext`.

## Context Props

`IterateContextProps` deliberately has only authority and local wiring:

```ts
type IterateContextProps = {
  scopes: { projects: "all" | string[] };
  mounts?: Mount[];
};
```

Scopes decide what can be reached. Mounts add execution-local shortcuts or
custom targets. There is no separate privileged context type: an all-projects
context is just `scopes: { projects: "all" }`.

Built-in roots are not user mounts. They are inferred from scopes and must not
grant authority that scopes do not already allow.

## Capability Tree

```text
ctx
├── projects
│   └── get(projectId)
│       ├── fetch(request)
│       ├── ingressFetch(request)
│       ├── egressFetch(request)
│       ├── streams
│       ├── repos
│       ├── workspace
│       │   └── git
│       ├── worker
│       └── connections
├── project    # shortcut when exactly one project is scoped
├── streams    # ctx.project.streams
├── repos      # ctx.project.repos
├── workspace  # ctx.project.workspace
└── worker     # ctx.project.worker
```

`ctx.project` is the same project capability as
`ctx.projects.get(scopedProjectId)`. It is not a wrapper with another `.project`
inside it.

## Project Capability

`ProjectCapability` is the project node in the tree. It wraps the existing
Project Durable Object capability and, for now, forwards the Project DO public
surface while adding child capabilities:

- `project.streams` calls the streams domain with the project ID in props.
- `project.repos` calls the repos domain with the project ID in props.
- `project.workspace` calls the workspace entrypoint with
  `{ projectId, workspaceId: "capnweb" }`.
- `project.workspace.git` exposes `add`, `clone`, `commit`, `push`, and
  `status`.
- `project.worker.fetch(request)` forwards to project fetch/ingress behavior.
- `project.worker.someTool(args)` forwards to
  `project.callConfigWorkerFunction({ functionName: "someTool", args })`.
- `project.connections.get(key)` returns a live Cap'n Web target previously
  registered through `project.provideCapability({ connectionKey, rpcTarget })`.

`ProjectsCapability.get(projectId)` returns a parent-owned `ProjectCapability`
for that project. The direct project ingress endpoint also returns a
`ProjectCapability`, backed by the local Project Durable Object capability.

## Mounts

A mount says: make a target available at a path on `ctx`.

```ts
type Mount = {
  path: string[];
  invoke?: "target" | "method";
  target: MountTarget;
};

type MountTarget =
  | { type: "ctx"; call?: TargetCall[] }
  | {
      type: "dynamic-worker";
      script: string;
      entrypoint?: string;
      loader?: { get: string };
      call?: TargetCall[];
    };

type TargetCall = string | { method: string; args?: unknown[] };
```

String `TargetCall` segments are property/getter reads. Object segments are
method calls:

```ts
["projects", { method: "get", args: ["proj_123"] }, "streams"];
// ctx.projects.get("proj_123").streams
```

Default `invoke` is `"target"`:

```ts
{
  path: ["tools"],
  target: { type: "dynamic-worker", script: toolsWorkerSource },
}

using tools = await ctx.tools;
await tools.echo({ text: "hi" });
```

Use `invoke: "method"` when the mount itself should be callable:

```ts
{
  invoke: "method",
  path: ["append"],
  target: {
    type: "ctx",
    call: ["projects", { method: "get", args: ["proj_123"] }, "streams", "append"],
  },
}

await ctx.append({ streamPath, event });
```

Mount lookup uses the most specific path. Runtime mounted members are installed
on a per-instance prototype, not on `IterateContext.prototype`, so mounted names
cannot leak between contexts.

## Dynamic Worker Mounts

Dynamic-worker mounts are loaded and invoked by the parent worker that owns the
`LOADER` binding. A `/run` dynamic worker must not receive or transfer the
mounted dynamic-worker entrypoint.

For built-ins, `/run` uses the real context from `await env.ITERATE.context`.
For dynamic-worker mount roots only, `/run` overlays a local marker that calls
back to parent-owned `env.ITERATE.callMounted([root, ...path], args)`.

The parent then resolves the mount, loads/reuses the dynamic worker, walks any
`target.call` path, awaits intermediate getter/RPC-promise values, and calls the
final method with the correct receiver.

## SDK-Shaped Paths

SDKs like Slack have method trees we should not predeclare. A normal mounted
target can expose a getter that returns `localProxyCaller(...)`:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { localProxyCaller } from "./local-proxy-wrapper.js";

export default class SlackTarget extends WorkerEntrypoint {
  get sdk() {
    return localProxyCaller(({ path, args }) => this.call({ path, args }));
  }

  async call({ path, args }) {
    return { method: path.join("."), args };
  }
}
```

Mounted with `call: ["sdk"]`, this lets callers write:

```ts
using slack = await ctx.slack;
await slack.chat.postMessage({ channel: "C123", text: "hi" });
```

Only marker values get this local path-proxy behavior. Normal Cap'n Web and
Workers RPC stubs pass through untouched.

## `/run` And Vitest

`/api/captnweb/run` should stay small. It imports the local SDK marker adapter,
resolves `ctx` from `env.ITERATE.context`, invokes the provided function, and
returns JSON.

Workerd supports native `using` for the compatibility date used here. If Vitest
or esbuild lowers `using` before `fn.toString()`, that is a test serialization
problem. The e2e helper wraps lowered function strings with esbuild's
explicit-resource-management helper preamble before posting to `/run`; `/run`
does not import those helpers.

## E2E Scenarios

`e2e/vitest/captnweb.e2e.test.ts` is the executable design proof. The main
scenario scripts run through both the Node Cap'n Web runner and the `/run`
dynamic-worker runner. That intentionally restricts those scripts to
serializable return values and proves the same code can execute in both places.

It covers:

- Root project administration through `ctx.projects`.
- The same script body running from Node and from `/run`.
- Direct project ingress at `/__iterate/capnweb`.
- Project-provided Cap'n Web targets via `project.provideCapability(...)`.
- Updating iterate-config through `ctx.project.workspace.git`.
- Calling iterate-config tools through `ctx.project.worker.someTool(...)`.
- `ctx.project.fetch(...)` and `ctx.project.egressFetch(...)`.
- Dynamic-worker target mounts.
- Root method mounts.
- `ctx`-derived shortcuts.
- Slack-style SDK marker paths like `ctx.sdk.chat.postMessage(...)`.
