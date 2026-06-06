# Iterate Context Runtime Learnings

This file captures concrete runtime facts discovered while implementing the
Cap'n Web / Dynamic Workers IterateContext model. These are not design goals;
they are constraints observed in workerd and Cap'n Web while making the e2e
suite pass.

## Dynamic worker entrypoints do not cross worker boundaries

Entrypoints returned by `env.LOADER.load(...).getEntrypoint()` cannot be returned
from one Worker to another Worker. Workerd throws:

```text
Entrypoints to dynamically-loaded workers cannot be transferred to other Workers,
because the system does not know how to reload this Worker from scratch.
Instead, have the parent Worker expose an entrypoint which constructs the
dynamic worker and forwards to it.
```

The practical rule is: keep the dynamic worker entrypoint private to the Worker
that loaded it. Expose a stable parent-owned method that forwards calls into the
dynamic worker.

## `/run` should be a JSON bridge

The root `/api/captnweb/run` path executes codemode-shaped snippets in a dynamic
Worker, but its response should always be plain JSON. Snippets may use Cap'n Web
/ Workers RPC internally, but the snippet result must be serializable.

## WorkerLoader cannot be passed into a dynamic worker

The `WorkerLoader` binding itself is not serializable. Passing `env.LOADER` as a
binding into another dynamic Worker fails with:

```text
DataCloneError: Could not serialize object of type "WorkerLoader".
This type does not support serialization.
```

So a dynamic worker cannot be given the parent loader binding and load its own
mount workers that way. Loading and forwarding must happen in the parent Worker
that already has the loader binding.

## Dynamic-to-dynamic worker forwarding also hits entrypoint transfer limits

A dynamic `/run` worker calling `env.ITERATE.callMounted(["tools", "echo"], ...)`
cannot have the parent Worker load another dynamic worker and return that
entrypoint's method result over the same RPC call. Even when the parent keeps the
entrypoint private and only returns the method result, workerd still throws the
dynamic entrypoint transfer error at the caller.

For `/run`, the practical workaround is to load user mount scripts as modules in
the same dynamic worker that runs the snippet. The snippet still calls
`ctx.tools.echo(...)`, but that dynamic-worker mount is invoked in-process inside
the `/run` worker. Built-in ctx mounts still forward through `env.ITERATE`.

Project config `worker.js` is a different case: it receives `env.ITERATE` from
the parent and should call built-in capabilities like
`env.ITERATE.context.streams.append(...)`. That path must not require loading a
second dynamic worker from inside the config worker.

Two smaller direct-RPC variants were tested and failed with the same workerd
error:

- passing the real `ctx: await env.ITERATE.context` into `/run` snippets and
  exposing dynamic-worker mounts like `ctx.tools` as real prototype getters;
- keeping the real context for built-ins but using a tiny local path proxy that
  called `env.ITERATE.callMounted(["tools", "echo"], args)` for dynamic-worker
  mount roots.

Both preserve the desired authoring shape in JavaScript, but both still make a
dynamic worker call the parent which then calls a second dynamically-loaded
worker. Today that boundary fails before the result can be returned. The current
`/run` implementation therefore inlines dynamic-worker mount scripts into the
same dynamic worker as the snippet. That bridge is not just ergonomic sugar; it
keeps mounted dynamic-worker tools in-process where workerd allows the call.

Injecting the real `IterateContext` into `/run` is still useful. Built-in
capabilities can use the same object as Node Cap'n Web tests, while only
dynamic-worker user mounts need the local in-process module bridge.

## Project config worker capabilities need a facade too

`ctx.project.worker` must not expose the raw dynamic worker entrypoint returned
by the Project Durable Object's loader. Calling `getConfigWorker()` across an
RPC boundary hits the same dynamic entrypoint transfer rule.

The workable shape is a parent-owned `ProjectWorkerCapability` facade:

- `ctx.project.worker.fetch(request)` forwards to project ingress/fetch.
- `ctx.project.worker.someTool(args)` forwards to a Project Durable Object method
  such as `callConfigWorkerFunction({ functionName: "someTool", args })`.

That keeps the config worker entrypoint inside the Project Durable Object.

## Local dev Artifacts can fail below IterateContext

The local Alchemy dev app currently binds the real Cloudflare Artifacts binding.
When that remote proxy fails, project setup fails while creating the
`iterate-config` repo with:

```text
Error: WebSocket connection failed.
```

The failure happens below the context tree, inside
`RepoDurableObject.createRepo()` when the repo DO calls the Artifacts binding.
It affects tests that need the project config repo or default project worker,
but context-only calls such as project CRUD, project-scoped streams, and dynamic
mount dispatch can still pass.

Running `pnpm artifacts:seed-config-base` can still succeed because that script
talks to the Cloudflare Artifacts REST API from Node. That does not prove the
Worker runtime `ARTIFACTS` binding is healthy; project setup can still fail when
the Worker calls the binding at runtime.

## Cloudflare Artifacts fallback must tolerate partial repo creation

The REST fallback for Cloudflare Artifacts can see a `409` from
`POST /repos/<source>/fork` when a previous attempt created the target artifact
repo but did not finish the Repo Durable Object's local storage/event setup.

For the `iterate-config` path, treating that conflict as idempotent is the right
shape: read the target repo and let the Repo Durable Object continue creating
its token and appending the repo-created event. This keeps retries clean without
special-casing the caller.

The follow-up read can also return `409` for a short period with a message like
`Repository "<name>" is currently being forked and is not yet available.; Retry
after 5 seconds.` The fallback needs to poll the target repo until the fork
finishes instead of assuming that a conflict means the repo is immediately
readable.

## Do not put worker e2e helpers under `/__debug`

The local Cloudflare dev server reserves `/__debug` and returns the devtools
redirect HTML before the Worker fetch handler sees the request. That is why a
JSON echo endpoint under `/__debug/egress-echo` worked conceptually but failed
in local e2e with HTML parse errors.

Use an app-owned route such as `/api/captnweb/egress-echo` for e2e helper
endpoints that need to work in both local dev and deployed preview workers.
When a local e2e uses `APP_CONFIG_BASE_URL=http://127.0.0.1:5173` for the Node
client, worker-to-worker egress should target the Doppler dev tunnel instead,
for example with `OS_E2E_EGRESS_ECHO_BASE_URL=https://os.iterate-dev-jonas.com`.

## Canonical MCP is app-scoped and project-selected

The current MCP endpoint is the app-level `/mcp`, derived from
`APP_CONFIG_BASE_URL`. The old project-hostname-derived MCP URL is no longer
enough.

Admin MCP tokens can see multiple projects, so `exec_js` calls through the
canonical endpoint must include the selected project slug or ID in the tool
arguments:

```ts
await client.callTool({
  name: "exec_js",
  arguments: { code, project: fixture.project.slug },
});
```

Without that argument the tool input schema rejects the call when more than one
project is available to the token.

## New stream subscriptions use the stream event dialect

OS now runs the newer stream runtime for built-in processors. Its outbound
subscription event is:

```ts
{
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey,
    subscriber: {
      type: "built-in",
      transport: "capnweb-websocket",
      processorSlug,
    },
  },
}
```

The older `events.iterate.com/core/subscription-configured` event with
`{ slug, type: "callable", callable }` can still pass some public validation,
but it does not reconcile the new built-in stream processor runners. Tests that
need the Slack router should subscribe the built-in `slack` processor directly
with the new shape.

## OS codemode event providers wait by reading the stream

The portable shared codemode processor can wait for event-provider completions
through a stream subscription. OS codemode scripts normally call a
`CodemodeSession` Durable Object capability instead, because dynamic workers use
that parent-owned session capability while executing.

In that DO path, event-provider calls append
`codemode/function-call-requested` and then read the same stream until the
matching `codemode/function-call-completed` arrives. Relying on
`CodemodeSession.afterAppend()` for that completion is not enough unless the
session is also configured as a live callable subscriber for completion events.

## Slack-routed agent streams are real agent streams

When the Slack router creates `/agents/slack/<channel>/<thread>` it wakes the
Agent Durable Object for that stream. That initialization registers the agent
processors and appends the default setup events, including
`events.iterate.com/agent/llm-config-updated`.

An e2e test for Slack routing should not assert that this setup event is absent.
The useful negative assertion is narrower: routing the Slack webhook should not
append `events.iterate.com/agent-chat/*` output before the bang command or debug
command has actually run.

The Slack `!debug` reply links to the project stream viewer at
`/projects/<projectSlug>/streams/<streamPath>`, not an organization settings
route. Tests should assert that direct stream URL and avoid depending on older
org-scoped navigation.

## `/run` snippets need the explicit-resource-management helpers

Vitest lowers `using` declarations inside test helper functions before
`fn.toString()` reaches the `/run` dynamic worker. The serialized function body
therefore references helper globals such as `__using()` and `__callDispose()`,
but those helpers are not included in the function string.

The `/run` wrapper must provide those helpers if we want the same function body
to run in Node and in Cloudflare dynamic workers. Local in-process proxy values
created only for `/run` should expose a no-op `Symbol.dispose`; real RPC stubs
still use their own disposal behavior.

## Local SDK proxies must be marker-only

The helper that turns a marker-returning target into
`ctx.sdk.chat.postMessage(...)` must not broadly wrap every object and function
returned by Cap'n Web or Workers RPC. Ordinary RPC stubs already have
runtime-specific receiver and method-call behavior. Rebinding those functions
can break mounted prototype methods with errors such as:

```text
TypeError: this.callMounted is not a function
```

The safe shape is marker-only: normal RPC values pass through untouched, while a
server-side marker from `localProxyCaller(...)` becomes a local path proxy. That
keeps `using sdk = await ctx.sdk` and `await sdk.chat.postMessage(...)`
ergonomic without changing the semantics of built-in calls like
`await ctx.append(...)` or `await ctx.projects.get(id)`.

SDK-shaped mounts do not need a separate wildcard mount mode. A normal mounted
target can expose a getter such as `get sdk() { return localProxyCaller(...) }`,
and the mount resolver can pass the path remainder into that marker. This works
for root shortcuts like `ctx.sdk.chat.postMessage(...)` and nested shortcuts like
`ctx.some.path.sdk.chat.postMessage(...)`; the most-specific mount lookup still
selects the correct target.

The marker's `call` should be a plain function, not a tiny `RpcTarget` with an
`invoke()` method. Functions already cross Cap'n Web and Workers RPC by
reference, so `{ __localProxyCaller: true, call }` is enough: the marker object
crosses by value, and the function remains the server-owned capability with its
captured closure.

## Built-in context roots should not be expressed as user mounts

`ctx.projects`, `ctx.project`, `ctx.streams`, `ctx.repos`, `ctx.workspace`, and
`ctx.worker` are the stable root capability tree. They should be direct
`IterateCapability` getters inferred from scopes, not generated entries in the
same `mounts` array used for user-provided shortcuts and tools.

This keeps the security boundary easier to read: scopes determine the built-in
tree, while mounts only add execution-local shortcuts or custom targets. A
single-project `ctx.project` now reads directly as `ctx.projects.get(projectId)`,
which is the intended symmetry with other project-domain capabilities.
