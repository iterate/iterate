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

`/api/captnweb/admin-cookie` and `/__iterate/capnweb/admin-cookie`
: Test-only browser auth bridge for Cap'n Web. Browser WebSockets cannot set
custom `Authorization` headers, so the browser e2e helper posts the admin bearer
token to the same host it is about to open a WebSocket to. That host sets an
`iterate-admin-auth` cookie, and only the Cap'n Web root/project handlers accept
that cookie.

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

## Iterate-Config Context Props

The project `worker.js` may export `getIterateContextProps()` to describe mounts
that should exist inside its own RPC-style tools:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Worker extends WorkerEntrypoint {
  getIterateContextProps() {
    return {
      mounts: [
        {
          path: ["slack"],
          target: {
            type: "ctx",
            call: ["project", "connections", { method: "get", args: ["slack-sdk"] }, "sdk"],
          },
        },
      ],
    };
  }

  async postDailyReport(input) {
    const ctx = await this.env.ITERATE.context;
    using slack = await ctx.slack;
    return await slack.chat.postMessage(input);
  }
}
```

This hook is deliberately not an authority hook. The Project Durable Object
accepts `mounts` from `worker.js`, then overwrites `scopes` with the current
project before constructing `env.ITERATE.context`. Config code can define local
shortcuts for capabilities it can already reach, but it cannot grant itself
access to other projects.

Because Dynamic Worker env bindings are fixed at load time, tool calls use a
two-step load when this hook exists: load once with the default project context,
read `getIterateContextProps()`, then load the same worker code for the actual
tool call with the mounted context. Ingress `fetch` keeps using the normal
cached project worker.

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

`src/capnweb/e2e` is the executable design proof. The scenario code is written
as shared codemode-shaped functions, then run through the registered execution
modes: browser Cap'n Web, Node over Cap'n Web, the `/run` dynamic-worker
endpoint, and the makeshift Node CLI in `src/capnweb/cli.ts`. The browser mode
runs in Vitest's browser project, while the Node project loops over Node,
`/run`, and CLI. A future Workers for Platforms mode should be added beside
those modes. The shared functions intentionally return serializable values and
prove the same code can execute in each place.

It covers:

- Root project administration through `ctx.projects`.
- The same script body running from browser, Node, `/run`, and the CLI.
- Direct project ingress at `/__iterate/capnweb`.
- Project-provided Cap'n Web targets via `project.provideCapability(...)`.
- Updating iterate-config through `ctx.project.workspace.git`.
- Calling iterate-config tools through `ctx.project.worker.someTool(...)`.
- `ctx.project.fetch(...)` and `ctx.project.egressFetch(...)`.
- Dynamic-worker target mounts.
- Root method mounts.
- `ctx`-derived shortcuts.
- Slack-style SDK marker paths like `ctx.sdk.chat.postMessage(...)`.
