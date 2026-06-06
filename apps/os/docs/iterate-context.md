# Iterate Context Capability Model

Everything callable in a project should be reachable through
one canonical capability tree under a capability we call the `IterateContext`

The way we write code that interacts with a project should be ~the same across

- first party application code (e.g. our orpc procedures)
- dynamic workers
  - codemode snippets written by us or LLMs
  - a project's iterate config worker.js
- vitest e2e tests running in node
- CLI scripts we use for interacting with projects

We want to implement a capability based security model where callers are passed RpcStubs that are scoped to only what the caller is allowed to do.

Initially, there will only be one binary scope. Either a caller has access to a project or not. If they do, they can do anything. Otherwise nothing.

BUT IMPORTANT: Even from the very beginning, it must be completely impossible for callers in one project to modify another.

## Design Goals

- Project-scoped work should run through a project-scoped `IterateContext`.
- Cap'n Web sessions for a project should terminate in the project Durable
  Object, not in the stateless edge worker.
- Dynamic workers should receive a skinny `env.ITERATE` binding and access the
  project context through `env.ITERATE.context`.
- Codemode should be a tiny wrapper around a dynamic worker:

  ```ts
  export default {
    async run(_request, env) {
      return await userSnippet(env.ITERATE.context);
    },
  };
  ```

- Codemode-specific sugar, such as `ctx.stream`, should be contextual helper
  methods layered on top of the canonical tree, not a second tool system.
- Domain implementations should expose capability objects that can later receive
  the same project access facts the caller already proved. Do not invent a
  second authorization model inside codemode.
- A canonical path under `ctx` is not a promise that the call routes through the
  project Durable Object. `ctx.streams`, `ctx.repos`, `ctx.workspace`,
  `ctx.integrations.slack`, and future domain capabilities should bypass the
  project DO whenever they can enforce the same project scope directly.

## Domains And Capabilities

`apps/os` is structured into domains such as projects, streams, repos,
workspaces, secrets, Slack, and agents. A domain may own Durable Objects,
WorkerEntrypoints, stream processors, database projections, or all of those.

The capability rule is:

```ts
class SomeDomainDurableObject extends DurableObject {
  getCapability(props: { scopes: { projectId: string } }) {
    return new SomeDomainCapability({
      durableObject: this,
      scopes: props.scopes,
    });
  }
}

class SomeDomainCapability extends RpcTarget {
  // Narrow, domain-shaped API.
}
```

Not every domain has this exact method today. Some capabilities are already
implemented as `WorkerEntrypoint`s or helper constructors. The target is that
callers do not care whether a method ultimately talks to a Durable Object, a
WorkerEntrypoint, an SDK client, a stream, or a config worker. They see a
capability tree.

## Capability Paths And Routing Paths

The capability tree is the caller-facing authority model. It is not the
execution topology.

This matters for scalability. The project Durable Object is a singleton
coordination point for one project, so it is useful for project-owned state and
sessionful operations, but it must not become the mandatory hop for every
project-scoped call. A high-volume stream append, repo operation, workspace
operation, secret lookup, or Slack API call should use a domain capability that
receives the same project scope and talks directly to its own backing runtime.

In other words, these two calls can both be canonical project-scoped calls:

```ts
await ctx.project.describe(); // likely project DO, because it is project-owned
await ctx.streams.get("/agents/slack/C123/ts-123").append(event); // stream runtime directly
```

The routing rule:

- Use the project Durable Object when the operation needs project singleton
  state, project lifecycle coordination, project ingress/config-worker behavior,
  or a project-scoped Cap'n Web session anchor.
- Bypass the project Durable Object when the target domain can enforce
  `{ scopes: { projectId } }` itself and has its own scalable runtime.
- Keep this invisible to callers. The canonical path is chosen by domain
  meaning, not by the internal hop sequence.

## Scopes

Do not over-design this yet. The current capnweb e2e flow proves only two
authorization shapes:

- The root Cap'n Web endpoint is opened with a bearer token that grants
  all-project scopes:

```ts
using root = withRootIterateContextFromNode({ auth, baseUrl });
const project = await root.projects.create({ slug });
```

- The project Cap'n Web endpoint is reached through that project's ingress URL
  and terminates in that project Durable Object:

```ts
using iterate = withIterateFromNode({
  auth,
  ingressUrl: project.ingressUrl,
});

await iterate.ctx.project.describe();
```

For now, project access comes from the fact that the caller reached the correct
project Durable Object and authenticated to that endpoint. Once inside a project
context, all exposed project operations are allowed. Future narrowing should
start from the access facts already present at that boundary, not from a new
abstract scope type invented in this document.

## Root Capabilities

There should be one root capability model: `IterateContext`.

All-project access is not a separate kind of context. It is an `IterateContext`
whose `scopes` allow cross-project access and whose mount list may be empty:

```ts
const ctx = iterate.with({
  scopes: { projects: "all" },
});

const project = await ctx.projects.create({ slug });
const page = await ctx.projects.list({ limit: 100 });
const sameProjectCtx = ctx.projects.get(project.id);
await ctx.projects.remove({ id: project.id });
```

Project access is the same context shape with narrower `scopes` and a few
well-known shortcut mounts:

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [projectShortcutMount({ projectId: "proj_123" })],
});
```

The full tree stays available wherever the scope permits it:

```ts
await ctx.projects.get("proj_123").describe();
await ctx.projects.get("proj_123").ingressFetch(request);
await ctx.projects.get("proj_123").streams.get("/agent/thread").append(event);
```

Mounts create shortcuts, not a second context type:

```ts
ctx.project === ctx.projects.get("proj_123");
ctx.streams === ctx.projects.get("proj_123").streams;
```

An agent or codemode stream can add a current-stream shortcut mount:

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [
    projectShortcutMount({ projectId: "proj_123" }),
    streamShortcutMount({
      projectId: "proj_123",
      streamPath: "/agents/slack/C123/ts-123",
    }),
  ],
});

await ctx.project.describe();
await ctx.stream.append(event);
```

## Context Mounts

`scopes` answer "what may this context access?" Context mounts answer "what
extra RPC target or method should appear at which `ctx` path in this execution?"

The canonical roots should stay stable:

```ts
ctx.projects.get("proj_123");
ctx.streams.get("proj_123:/agents/slack/C123/ts-123");
ctx.integrations.slack.chat.postMessage(...);
```

But a specific execution may add shortcuts or custom tools directly onto `ctx`:

```ts
ctx.project; // mount-provided shortcut
ctx.stream; // mount-provided shortcut
ctx.rootMethod({ value: 1 }); // mount-provided method
ctx.tools.someMethod({ value: 1 }); // mount-provided target
ctx.tools.nested.someMethod({ value: 1 }); // target-owned nested RPC shape
```

The mount object should be direct. The object is the mount; it has a `ctx`
path, a target expression, and an optional `invoke` mode. `invoke: "target"` is
the default because the most common operation is "make this RPC target
available at this `ctx` path".

```ts
type IterateContextProps = {
  scopes: ProjectScopes;
  mounts?: Mount[];
};

type Mount = {
  path: string[];
  invoke?: "target" | "method" | "catchall";
  target: MountTarget;
};

type MountTarget =
  | {
      type: "dynamic-worker";
      script: string;
      entrypoint?: string;
      loader?: { get: string };
      call?: TargetCall[];
    }
  | {
      type: "ctx";
      call?: TargetCall[];
    };

type TargetCall =
  | string
  | {
      method: string;
      args?: unknown[];
    };
```

The semantics are:

```ts
// Default target mount.
ctx.<path> -> resolveTarget(target)

// Method mount:
ctx.<path>(...args) -> resolveTarget(target)(...args)

// Catchall mount:
ctx.<path>.<remainder>(...args) -> resolveTarget(target)({ path: remainder, args })
```

The `path` is where the mount appears on `ctx`. `target.call` is a small chain
that starts at the target and resolves the final value. A string segment means
property/getter access. An object segment means method invocation.

```ts
call: ["branches", { method: "get", args: ["main"] }];
// target.branches.get("main")
```

This keeps getter-friendly RPC APIs readable while still making method calls and
arguments explicit.

### Target Mount

The common case should be tiny: put a normal Workers RPC target at a `ctx` path.

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [
    {
      path: ["tools"],
      target: {
        type: "dynamic-worker",
        script: `
          import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

          class IssueTools extends RpcTarget {
            async create(input) {
              return { created: true, input };
            }
          }

          export default class Tools extends WorkerEntrypoint {
            async summarize(input) {
              return { summary: "done", input };
            }

            get issues() {
              return new IssueTools();
            }
          }
        `,
      },
    },
  ],
});
```

This enables ordinary RPC calls:

```ts
await ctx.tools.summarize({ stream: "/agents/a" });
await ctx.tools.issues.create({ title: "Fix mount model" });
```

The target owns its nested API. `IterateContext` does not need to know that
`tools.issues.create` exists. It only knows that `ctx.tools` returns the mounted
target.

If a caller wants to mount only a nested target, use `target.call`:

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [
    {
      path: ["issues"],
      target: {
        type: "dynamic-worker",
        script: toolsWorkerSource,
        call: ["issues"],
      },
    },
  ],
});

await ctx.issues.create({ title: "Fix mount model" });
```

### Method Mount

Use method mounts for shortcut methods directly on `ctx`.

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [
    {
      invoke: "method",
      path: ["summarize"],
      target: {
        type: "dynamic-worker",
        script: `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export default class Tools extends WorkerEntrypoint {
            async summarize(input) {
              await this.env.ITERATE.context.stream.append({
                type: "events.iterate.com/tool-called",
                payload: input,
              });
              return { ok: true };
            }
          }
        `,
        call: ["summarize"],
      },
    },
  ],
});

await ctx.summarize({ stream: "/agents/a" });
```

The implementation should install method mounts on a per-instance prototype,
not on the shared `IterateContextCapability.prototype`:

```ts
function installMountedMethods(target: IterateContextCapability, mounts: Mount[]) {
  const instancePrototype = Object.create(Object.getPrototypeOf(target));

  for (const mount of mounts) {
    if (mount.invoke !== "method") continue;
    if (mount.path.length !== 1) {
      throw new Error("method mounts must be root-level in v1");
    }

    const methodName = mount.path[0]!;
    Object.defineProperty(instancePrototype, methodName, {
      value: async function mountedMethod(...args: unknown[]) {
        return await this.callMounted(mount.path, args);
      },
      writable: false,
      configurable: true,
    });
  }

  Object.setPrototypeOf(target, instancePrototype);
}
```

This is normal Workers RPC because the method is visible on the instance's
prototype. It avoids leaking one execution's mounts into another execution.

### Project And Stream Shortcuts

Project and stream shortcuts are just mounts over canonical roots.

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [
    {
      path: ["project"],
      target: {
        type: "ctx",
        call: ["projects", { method: "get", args: ["proj_123"] }],
      },
    },
    {
      path: ["stream"],
      target: {
        type: "ctx",
        call: [
          "projects",
          { method: "get", args: ["proj_123"] },
          "streams",
          { method: "get", args: ["proj_123:/agents/my-agent-stream"] },
        ],
      },
    },
  ],
});

await ctx.project.ingressFetch(request);
await ctx.stream.append(event);
```

The shortcut does not grant authority. The dynamic worker can only call
`env.ITERATE.context.streams.get(...)` if the parent `IterateContext` scopes allow
that project.

### Catchall Mounts

Catchall mounts are for SDK-like APIs where Iterate should not know the method
hierarchy ahead of time.

```ts
const ctx = iterate.with({
  scopes: { projects: ["proj_123"] },
  mounts: [
    {
      invoke: "catchall",
      path: ["slack"],
      target: {
        type: "dynamic-worker",
        script: `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export default class SlackFacade extends WorkerEntrypoint {
            async call({ path, args }) {
              return await this.env.ITERATE.context.integrations.slack.request({
                method: path.join("."),
                args,
              });
            }
          }
        `,
        call: ["call"],
      },
    },
  ],
});

await ctx.slack.chat.postMessage({ channel: "C123", text: "hi" });
```

The intended call collapse is:

```ts
await target.call({
  path: ["chat", "postMessage"],
  args: [{ channel: "C123", text: "hi" }],
});
```

The exact open runtime question is:

> Can a normal Workers RPC / Cap'n Web target expose an unbounded property chain
> such that `ctx.slack.chat.postMessage(args)` crosses an RPC boundary and the
> server-side target receives one `call({ path: ["chat", "postMessage"], args })`
> invocation, without predeclaring `chat` or `postMessage` on a prototype?

The smallest possible test is:

```ts
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class Catchall extends RpcTarget {
  constructor() {
    super();
    return createPathProxy([]);
  }
}

function createPathProxy(path) {
  return new Proxy(async (...args) => ({ path, args }), {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return createPathProxy([...path, prop]);
    },
  });
}

class GetterReturnsCatchall extends RpcTarget {
  get slack() {
    return createPathProxy([]);
  }
}

export class Probe extends WorkerEntrypoint {
  async testConstructorProxy(target) {
    return await target.slack.chat.postMessage({ text: "hi" });
  }

  async testGetterProxy(target) {
    return await target.slack.chat.postMessage({ text: "hi" });
  }
}
```

The intuition for why it might work is reasonable: a local JavaScript proxy can
turn arbitrary property access into a path and then make the final function call.

```ts
const slack = createPathProxy([]);
await slack.chat.postMessage({ text: "hi" });
// returns { path: ["chat", "postMessage"], args: [{ text: "hi" }] }
```

The reason it does not work over Workers RPC today is that the client-side RPC
stub does not forward unknown property reads to the server-side JavaScript
`get` trap. It sends RPC operations against methods/properties that Workers RPC
can expose. For `RpcTarget`, `WorkerEntrypoint`, and `DurableObject`, that means
class-declared methods/getters on the RPC-visible shape, not arbitrary proxy
properties. If the proxy object itself crosses the RPC boundary, workerd cannot
create a normal RPC stub for that proxy.

The POC in `packages/shared/iterate-context-mounts-poc` tried the relevant
variants:

- `RpcTarget` constructor returns a `Proxy`: crossing RPC fails with
  `DataCloneError: Couldn't create a stub for the Proxy`.
- `RpcTarget` getter returns a `Proxy`: `slack.chat` fails with
  `TypeError: The RPC receiver does not implement the method "chat"`.
- `WorkerEntrypoint` constructor returns a `Proxy`: direct RPC stub access fails
  at `slack.chat` with the same missing-method error.

So today, normal Workers RPC does not prove the ergonomic catchall spelling
`ctx.slack.chat.postMessage(...)`. The canonical model should still include
`invoke: "catchall"` because it captures the desired authority and dispatch
semantics. The implementation may initially have to expose the same target as:

```ts
await ctx.slack.call({
  path: ["chat", "postMessage"],
  args: [{ channel: "C123", text: "hi" }],
});
```

If Cloudflare later supports server-side catchall RPC stubs, the user-facing
catchall spelling can become:

```ts
await ctx.slack.chat.postMessage({ channel: "C123", text: "hi" });
```

without changing the mount data model.

The smallest local-only version of the proxy does work:

```ts
function createLocalPathProxy(path = []) {
  return new Proxy(async (...args) => ({ path, args }), {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return createLocalPathProxy([...path, prop]);
    },
  });
}
```

But that local object is not, by itself, a normal cross-Worker RPC target.

### Mount Resolution

Mount resolution should reuse the current codemode rule: choose the most
specific registered path that prefixes the requested path.

```ts
function resolveMount(mounts: Mount[], path: string[]) {
  const candidates = mounts
    .filter((mount) => isPathPrefix(mount.path, path))
    .sort((a, b) => b.path.length - a.path.length);

  const mount = candidates[0];
  if (!mount) throw new Error(`No mount registered for ${path.join(".")}`);

  return {
    mount,
    remainder: path.slice(mount.path.length),
  };
}

function isPathPrefix(prefix: string[], path: string[]) {
  return prefix.every((segment, index) => path[index] === segment);
}
```

Examples:

```ts
[
  { path: ["tools"], target: toolsWorker },
  { path: ["tools", "github"], target: githubWorker },
];
```

Then:

```ts
ctx.tools.summarize(...)
// matches ["tools"], remainder ["summarize"]

ctx.tools.github.issues.create(...)
// matches ["tools", "github"], remainder ["issues", "create"]
```

For `invoke: "target"`, the matched mount returns the resolved target at the
mount path and the target's normal RPC surface handles the remainder. For
`invoke: "method"`, the matched path must be the method path and the call invokes
the resolved function. For `invoke: "catchall"`, the remainder becomes the
`path` passed to the resolved function.

### Dynamic Workers As Targets

Cloudflare Dynamic Workers fit this mount model well:

- `load()` creates a fresh Worker and is right for one-off AI-generated tool
  calls.
- `get(id, getCode)` can reuse a warm isolate for stable targets such as a
  project config worker.
- The loader controls the child Worker's `env`, so the host can pass only
  `env.ITERATE` and any intentionally exposed bindings.
- A custom binding is already a Workers RPC capability. The dynamic worker sees
  a narrow object such as `this.env.CHAT_ROOM.post(...)`; the loader Worker
  keeps the real credentials, props, and backing resources.

Dynamic source code is therefore one way to manufacture a target. It is not a
separate codemode-only tool system.

### Rules

- Built-in canonical roots such as `projects`, `streams`, `repos`, `workspaces`,
  and `integrations` belong to Iterate and should be stable.
- Mounts are execution-local conveniences. Agent streams, codemode sessions,
  project config workers, and developer scripts can add them.
- Mounts must not grant authority by themselves. They can only compose
  capabilities already allowed by `scopes`.
- Name conflicts should be explicit. A mount should not silently replace a
  built-in root unless the host intentionally allows it.
- Prefer the default `invoke: "target"`. Use `invoke: "method"` for root method
  shortcuts. Use `invoke: "catchall"` only for APIs whose hierarchy is unknown
  by design.

## Project Context

The project is special in two ways:

1. It is the singleton resource behind a project-scoped `IterateContext`.
2. It is also part of the root collection, because projects can be created,
   listed, found, and removed.

Inside an `IterateContext`, `ctx.project` is the project resource capability.
It is a mount-provided shortcut over `ctx.projects.get(projectId)`, not shorthand for
an extra nested `ctx.projects.get(id).project` branch. Today each project
resource capability is backed by the project Durable Object because project
metadata, ingress behavior, config-worker loading, and project lifecycle state
are project-singleton concerns:

```ts
class ProjectsCapability extends RpcTarget {
  constructor(private readonly props: { scopes: ProjectScopes }) {
    super();
  }

  get(projectId: string) {
    assertCanAccessProject(this.props.scopes, projectId);
    return env.PROJECTS.getByName(projectId).getCapability({
      scopes: this.props.scopes,
    });
  }
}

ctx.project === ctx.projects.get("proj_123"); // when a mount provides that shortcut
```

That project capability should initially mirror the project Durable Object's
public method surface. This is intentionally literal: `ctx.project.fetch()`
calls `ProjectDurableObject.fetch()`, and `ctx.project.ingressFetch()` calls
`ProjectDurableObject.ingressFetch()`. Those names are not a new semantic model;
they are the current Durable Object API exposed through a capability wrapper.

```ts
await ctx.project.describe();
await ctx.project.fetch(request); // ProjectDurableObject.fetch(request)
await ctx.project.ingressFetch(request); // ProjectDurableObject.ingressFetch(request)
await ctx.project.callConfigWorkerFunction({
  functionName: "myTool",
  args: [{ value: 1 }],
});

await ctx.projects.get("proj_123").ingressFetch(request);
```

A codemode snippet should be able to call either project method without escaping
the tree:

```ts
async (ctx) => {
  const request = new Request("https://example.iterate.app/status");
  const viaDoFetch = await ctx.project.fetch(request);
  const viaIngressFetch = await ctx.project.ingressFetch(request);
  return {
    doFetchStatus: viaDoFetch.status,
    ingressStatus: viaIngressFetch.status,
  };
};
```

## Streams

Streams are core enough that their API should model the namespace/path split
clearly.

At the root, `ctx.streams` is a global stream collection addressed by fully
qualified stream names:

```ts
await ctx.streams.get("proj_123:/capnweb/project-session").append({
  type: "events.iterate.com/capnweb/project-session",
  payload: { marker },
});

const events = await ctx.streams.get("proj_123:/capnweb/project-session").read({
  afterOffset: "start",
});
```

That form should translate directly to the stream Durable Object capability, but
the root identifier is the domain API, not necessarily the raw Durable Object
name. Each domain owns its own identifier grammar and the mapping from that
identifier to the backing runtime name. Streams may use `projectId:/path`,
another domain may use a JSON structured name, and another may use a globally
unique ID.

```ts
class StreamsCapability extends RpcTarget {
  get(name: `${string}:${string}`) {
    const { projectId, path } = parseFullyQualifiedStreamName(name);
    assertCanAccessProject(this.ctx.props.scopes, projectId);
    return env.STREAM.getByName(streamDurableObjectName({ projectId, path })).getCapability({
      ...this.ctx.props,
    });
  }
}
```

The common rule is not "all domains use `namespace:name`." The common rule is
"the root collection accepts a stable domain identifier, checks scopes, and
resolves the correct capability."

Project-local stream collections are scoped views over that same root
collection:

```ts
ctx.projects.get("proj_123").streams.get("/some/stream");
// equivalent to:
ctx.streams.get("proj_123:/some/stream");
```

The project-local shortcut follows the same rule:

```ts
ctx.streams.get("/some/stream");
// equivalent to:
ctx.projects.get("proj_123").streams.get("/some/stream");
// equivalent to:
ctx.streams.get("proj_123:/some/stream");
```

And a current-stream mount creates the `ctx.stream` shortcut:

```ts
ctx.stream;
// equivalent to:
ctx.streams.get("/agents/slack/C123/ts-123");
```

The current e2e tests use a flatter transitional shape:

```ts
await iterate.ctx.streams.append({
  streamPath,
  event: { type: eventType, payload: { marker } },
});

const events = await iterate.ctx.streams.read({
  afterOffset: "start",
  streamPath,
});
```

The target shape is `ctx.streams.get(path).append(event)`. Codemode may add
contextual sugar for the current stream:

```ts
async (ctx) => {
  await ctx.stream.append({
    type: "events.iterate.com/agent/reply",
    payload: { text: "done" },
  });
};
```

That helper is equivalent to:

```ts
const stream = ctx.streams.get("/agents/slack/C123/ts-123");
await stream.append({
  type: "events.iterate.com/agent/reply",
  payload: { text: "done" },
});
```

The helper is not a new tool provider. It is just a local shortcut over the
canonical tree.

## Integrations And SDK Proxies

Integrations should also sit under the same tree. For example, Slack can be
modeled as a project integration whose capability proxies to the Slack SDK or
Web API:

```ts
async (ctx) => {
  await ctx.integrations.slack.chat.postMessage({
    channel: "C123",
    thread_ts: "123.456",
    text: "I found the issue.",
  });
};
```

Internally that can be backed by a path proxy:

```ts
class SlackCapability extends RpcTarget {
  get chat() {
    return new SlackMethodPath({
      methodPath: ["chat"],
      token: this.token,
    });
  }
}

class SlackMethodPath extends RpcTarget {
  get postMessage() {
    return async (body: Record<string, unknown>) => {
      return await slackClient.apiCall("chat.postMessage", body);
    };
  }
}
```

Or, for a fully generic SDK proxy:

```ts
class SlackMethodPath extends RpcTarget {
  child(segment: string) {
    return new SlackMethodPath({
      methodPath: [...this.methodPath, segment],
      token: this.token,
    });
  }

  async call(body: Record<string, unknown>) {
    return await slackClient.apiCall(this.methodPath.join("."), body);
  }
}
```

The important rule is that Slack is not a codemode-specific provider. It is a
normal project capability. Codemode simply receives `ctx`, so the same Slack
path works in codemode, Cap'n Web, dynamic workers, tests, and first-party code.

## Dynamic Workers

Project config workers and future Workers for Platforms workers should receive
a skinny named entrypoint:

```ts
export class IterateContextEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  get context() {
    return new IterateContext({
      env: this.env,
      exports: this.ctx.exports,
      scopes: { projectId: this.ctx.props.projectId },
    });
  }
}
```

The dynamic worker uses only `env.ITERATE.context`:

```ts
export default {
  async fetch(request, env) {
    const ctx = env.ITERATE.context;
    const url = new URL(request.url);
    const stream = ctx.streams.get(url.searchParams.get("streamPath"));

    const appended = await stream.append({
      type: url.searchParams.get("eventType"),
      payload: {
        marker: url.searchParams.get("marker"),
        source: "iterate-config",
      },
    });

    return Response.json({ offset: appended.offset });
  },
};
```

The current e2e test exercises the same idea with `env.ITERATE.context`:

```ts
const workerSource = dedent`
  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const ctx = env.ITERATE.context;
      const streamPath = url.searchParams.get("streamPath");
      const appended = await ctx.streams.append({
        streamPath,
        event: {
          type: url.searchParams.get("eventType"),
          payload: {
            marker: url.searchParams.get("marker"),
            source: "iterate-config",
          },
        },
      });
      return Response.json({ offset: appended.offset });
    },
  };
`;
```

The target API is `env.ITERATE.context`, with no compatibility alias.

## Codemode

Codemode should be the smallest possible layer over dynamic workers. The model
we want is:

```ts
async (ctx) => {
  const events = await ctx.streams.get("/capnweb/project-session").read({
    afterOffset: "start",
  });

  await ctx.integrations.slack.chat.postMessage({
    channel: "C123",
    text: `Found ${events.length} events.`,
  });
};
```

The host wraps that snippet:

```ts
import { env } from "cloudflare:workers";
import snippet from "./snippet.js";

export default {
  async run() {
    return await snippet(env.ITERATE.context);
  },
};
```

That should be enough to make all canonical tools available to the model. Local
helpers can be added later for ergonomics:

```ts
async (ctx) => {
  await ctx.stream.append({
    type: "events.iterate.com/agent/reply",
    payload: { text: "done" },
  });
};
```

But those helpers must stay secondary. The first goal is that every real tool is
available at one canonical nested path under `ctx`.

## Iterate Config Custom Tools

Project config can provide custom tools by exporting ordinary functions from
`worker.js`. Those functions can use `env.ITERATE.context` to reach first-party
capabilities and can be called through the project worker capability.

```ts
export default {
  async fetch(request, env) {
    const ctx = env.ITERATE.context;
    return Response.json({
      project: await ctx.project.describe(),
      requestUrl: request.url,
    });
  },

  async summarizeThread(input, env) {
    const ctx = env.ITERATE.context;
    const events = await ctx.streams.get(input.streamPath).read({
      afterOffset: "start",
    });

    await ctx.integrations.slack.chat.postMessage({
      channel: input.channel,
      thread_ts: input.thread_ts,
      text: `There are ${events.length} events in this thread.`,
    });

    return { eventCount: events.length };
  },
};
```

First-party code can call that project-defined tool through the same capability
tree under the project node:

```ts
const result = await ctx.project.worker.summarizeThread({
  channel: "C123",
  streamPath: "/agents/slack/C123/ts-123",
  thread_ts: "123.456",
});
```

This is how "custom tools" should fit the model: project config is another
domain capability under `ctx`, not a codemode-only registry.

## Cap'n Web Sessions

Project Cap'n Web sessions should terminate in `ProjectDurableObject`:

```ts
async fetch(request: Request) {
  const capnwebResponse = await this.handleProjectCapnwebFetch(request);
  if (capnwebResponse) return capnwebResponse;

  return await this.ingressFetch(request);
}

private async handleProjectCapnwebFetch(request: Request) {
  if (new URL(request.url).pathname !== "/__iterate/capnweb") return null;
  return newWorkersRpcResponse(request, await this.getIterateContext());
}
```

The stateless edge worker should only route the request to the right project DO:

```ts
if (url.pathname === "/__iterate/capnweb" && ingressMatch.rule.projectId) {
  return await env.PROJECT.getByName(
    getProjectDurableObjectName(ingressMatch.rule.projectId),
  ).fetch(request);
}
```

This keeps WebSocket/RPC session lifetime anchored to the project object.

## First-Party Application Code

oRPC handlers can use the same capabilities. Project collection APIs use the
root `IterateContext` with all-project scope:

```ts
export const projectsRouter = {
  projects: {
    create: os.projects.create.handler(async ({ context, input }) => {
      return await new ProjectsCapability({
        activeOrganization: context.activeOrganization,
        context,
      }).create(input);
    }),
  },
};
```

Project-scoped handlers should use an `IterateContext` for the current project:

```ts
const ctx = createIterateContext({ context, scopes: { projectId } });
return await ctx.streams.get(input.streamPath).read({
  afterOffset: input.afterOffset,
});
```

The point is not that every code path must literally go through Cap'n Web. The
point is that first-party application code, dynamic workers, codemode, and
tests should agree on the same conceptual capability tree. First-party handlers
should not call `projectDurableObject(...).getIterateContext()` just to reach a
domain capability that can be constructed directly from `context.workerExports`
and `{ scopes: { projectId } }`.

## E2E Shape

The capnweb e2e test should demonstrate three lanes:

```ts
using root = withRootIterateContextFromNode({ auth, baseUrl });

await using project = await createDisposableProject({
  root,
  slug: `capnweb-${uniqueSuffix()}`,
});

// Project lifecycle through the root Iterate context.
await root.projects.list({ limit: 1_000 });
await root.projects.get(project.id).describe();

// Project-scoped Cap'n Web session.
using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
await iterate.ctx.streams.get("/capnweb/project-session").append({
  type: "events.iterate.com/capnweb/project-session",
  payload: { marker },
});

// Dynamic project worker with env.ITERATE.context.
await iterate.ctx.workspace.writeFile(
  `${dir}/worker.js`,
  `
    export default {
      async fetch(request, env) {
        const ctx = env.ITERATE.context;
        return Response.json(await ctx.project.describe());
      }
    };
  `,
);
```

Those examples should stay close to production behavior: project sessions go
through the project DO, project config runs in a dynamic worker, and the
canonical capability tree is the same in both places even when individual
branches bypass the project DO.

## Open Implementation Tasks

- Expose `IterateContextEntrypoint.context`.
- Move streams from `ctx.streams.append({ streamPath, event })` to
  `ctx.streams.get(streamPath).append(event)`.
- Add real scope checks to `ProjectDurableObject.getCapability({ scopes })`;
  today the method records the shape but does not narrow the API yet.
- Make `IterateContext` construct non-project domain capabilities directly from
  `{ scopes }` and the domain's own runtime binding, rather than routing through
  the project Durable Object.
- Keep authorization facts aligned with the current capnweb e2e shape:
  all-project bearer auth for the root context, and project-context access
  through the project Durable Object selected by ingress/project ID.
- Model integrations under `ctx.integrations`, starting with Slack as a normal
  capability backed by the Slack SDK/Web API, not a codemode provider.
- Keep codemode focused on wrapping `async (ctx) => {}` and optional local
  shortcuts over canonical paths.
