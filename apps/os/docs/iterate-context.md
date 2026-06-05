# Iterate Context Capability Model

Everything callable in a project should be reachable through
one canonical capability tree under a capbility we call the `IterateContext`

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
  project context through `env.ITERATE.ctx`.
- Codemode should be a tiny wrapper around a dynamic worker:

  ```ts
  export default {
    async run(_request, env) {
      return await userSnippet(env.ITERATE.ctx);
    },
  };
  ```

- Codemode-specific sugar, such as `ctx.stream`, should be contextual helper
  methods layered on top of the canonical tree, not a second tool system.
- Domain implementations should expose capability objects that can later receive
  the same project access facts the caller already proved. Do not invent a
  second authorization model inside codemode.

## Domains And Capabilities

`apps/os` is structured into domains such as projects, streams, repos,
workspaces, secrets, Slack, and agents. A domain may own Durable Objects,
WorkerEntrypoints, stream processors, database projections, or all of those.

The capability rule is:

```ts
class SomeDomainDurableObject extends DurableObject {
  getCapability(props: { projectId: string }) {
    return new SomeDomainCapability({
      durableObject: this,
      projectId: props.projectId,
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

## Scopes

Do not over-design this yet. The current capnweb e2e flow proves only two
authorization shapes:

- The admin Cap'n Web endpoint is opened with the admin bearer token:

```ts
using admin = withAdminIterateFromNode({ auth, baseUrl });
const project = await admin.projects.create({ slug });
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

There are two roots.

`IterateAdminCapability` is for cross-project lifecycle:

```ts
using admin = withAdminIterateFromNode({ auth, baseUrl });

const project = await admin.projects.create({ slug });
const page = await admin.projects.list({ limit: 100 });
const sameProjectCtx = admin.projects.get(project.id);
await admin.projects.remove({ id: project.id });
```

`admin.projects.get(projectId)` may return an `IterateContext` because an admin
context is allowed to get into a project. Most application code should prefer a
project-scoped context when it already knows the project.

`IterateContext` is project-scoped. It is the main thing dynamic workers,
project Cap'n Web sessions, codemode snippets, and project internals should use:

```ts
const ctx = env.ITERATE.ctx;

await ctx.project.describe();
await ctx.streams.get("/agent/thread").append({
  type: "events.iterate.com/example",
  payload: { ok: true },
});
```

## Project Context

The project is special in two ways:

1. It is the singleton resource behind a project-scoped `IterateContext`.
2. It is also part of the admin collection, because projects can be created,
   listed, found, and removed.

Inside an `IterateContext`, `ctx.project` should be the project Durable Object's
own capability:

```ts
class IterateContext extends RpcTarget {
  constructor(private readonly props: { projectId: string }) {
    super();
  }

  get project() {
    return env.PROJECT.getByName(getProjectDurableObjectName(this.props.projectId)).getCapability({
      projectId: this.props.projectId,
    });
  }
}
```

That project capability should expose project-owned operations such as ingress
fetch and project metadata:

```ts
await ctx.project.describe();
await ctx.project.fetch(request);
await ctx.project.ingressFetch(request);
await ctx.project.callConfigWorkerFunction({
  functionName: "myTool",
  args: [{ value: 1 }],
});
```

A codemode snippet should be able to call project ingress without escaping the
tree:

```ts
async (ctx) => {
  const response = await ctx.project.fetch(new Request("https://example.iterate.app/status"));
  return await response.text();
};
```

## Streams

Streams are core enough that their API should model the namespace/path split
clearly.

The canonical shape should be:

```ts
await ctx.streams.get("/capnweb/project-session").append({
  type: "events.iterate.com/capnweb/project-session",
  payload: { marker },
});

const events = await ctx.streams.get("/capnweb/project-session").read({
  afterOffset: "start",
});
```

`ctx.streams` is a project-local collection. Its capability prefixes the project
namespace before touching the shared stream runtime. Callers should not encode a
project ID into stream paths.

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
  get ctx() {
    return env.PROJECT.getByName(
      getProjectDurableObjectName(this.ctx.props.projectId),
    ).getCapability({ projectId: this.ctx.props.projectId });
  }
}
```

The dynamic worker uses only `env.ITERATE.ctx`:

```ts
export default {
  async fetch(request, env) {
    const ctx = env.ITERATE.ctx;
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

The current e2e test exercises the same idea with `getContext()`:

```ts
const workerSource = dedent`
  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const ctx = env.ITERATE.getContext();
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

The target API is `env.ITERATE.ctx`, with no compatibility alias.

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
    return await snippet(env.ITERATE.ctx);
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
`worker.js`. Those functions can use `env.ITERATE.ctx` to reach first-party
capabilities and can be called through the project worker capability.

```ts
export default {
  async fetch(request, env) {
    const ctx = env.ITERATE.ctx;
    return await ctx.project.fetch(request);
  },

  async summarizeThread(input, env) {
    const ctx = env.ITERATE.ctx;
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
tree:

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
admin capability:

```ts
export const projectsRouter = {
  projects: {
    create: os.projects.create.handler(async ({ context, input }) => {
      return await new ProjectAdminCapability({
        activeOrganization: context.activeOrganization,
        context,
      }).create(input);
    }),
  },
};
```

Project-scoped handlers should use an `IterateContext` for the current project:

```ts
const ctx = await projectDurableObject(context, projectId).getIterateContext();
return await ctx.streams.get(input.streamPath).read({
  afterOffset: input.afterOffset,
});
```

The point is not that every code path must literally go through Cap'n Web. The
point is that first-party application code, dynamic workers, codemode, and
tests should agree on the same conceptual capability tree.

## E2E Shape

The capnweb e2e test should demonstrate three lanes:

```ts
using admin = withAdminIterateFromNode({ auth, baseUrl });

await using project = await createDisposableProject({
  admin,
  slug: `capnweb-${uniqueSuffix()}`,
});

// Admin lifecycle.
await admin.projects.list({ limit: 1_000 });
await admin.projects.get(project.id).project.describe();

// Project-scoped Cap'n Web session.
using iterate = withIterateFromNode({ auth, ingressUrl: project.ingressUrl });
await iterate.ctx.streams.get("/capnweb/project-session").append({
  type: "events.iterate.com/capnweb/project-session",
  payload: { marker },
});

// Dynamic project worker with env.ITERATE.ctx.
await iterate.ctx.workspace.writeFile(
  `${dir}/worker.js`,
  `
    export default {
      async fetch(request, env) {
        const ctx = env.ITERATE.ctx;
        return await ctx.project.fetch(request);
      }
    };
  `,
);
```

Those examples should stay close to production behavior: project sessions go
through the project DO, project config runs in a dynamic worker, and the project
capability tree is the same in both places.

## Open Implementation Tasks

- Rename `IterateContextEntrypoint.getContext()` to a `ctx` getter.
- Move streams from `ctx.streams.append({ streamPath, event })` to
  `ctx.streams.get(streamPath).append(event)`.
- Clarify the project Durable Object capability boundary so `ctx.project` can
  expose `fetch()`, `ingressFetch()`, project metadata, and project config
  worker calls.
- Keep authorization facts aligned with the current capnweb e2e shape: admin
  bearer auth for the admin root, and project-context access through the project
  Durable Object selected by ingress/project ID.
- Model integrations under `ctx.integrations`, starting with Slack as a normal
  capability backed by the Slack SDK/Web API, not a codemode provider.
- Keep codemode focused on wrapping `async (ctx) => {}` and optional local
  shortcuts over canonical paths.
