# Cap'n Web Runtime Learnings

These are implementation constraints observed while making the Cap'n Web
IterateContext model work in local workerd, deployed Workers, Dynamic Workers,
and Cap'n Web WebSocket tests.

## `/run` Returns JSON

`/api/captnweb/run` executes a codemode-shaped function in a dynamic worker, but
its transport result is always JSON. Snippets can use Cap'n Web or Workers RPC
stubs internally, but the final returned value must be serializable.

## Do Not Transfer Dynamic Worker Entrypoints

Dynamic workers loaded with `env.LOADER.load(...).getEntrypoint()` must stay
owned by the worker that has the loader binding. Do not pass those entrypoints,
their bound methods, or unresolved RPC promises into another dynamic worker.

`WorkerLoader` itself is also not serializable, so do not pass `env.LOADER` into
a child dynamic worker and ask the child to load its own mount workers. Loading
and forwarding stays in the parent worker.

The working shape for dynamic-worker mounts is:

- `/run` receives `env.ITERATE`.
- `/run` resolves built-ins with `await env.ITERATE.context`.
- `/run` overlays only dynamic-worker mount roots with a marker that calls
  `env.ITERATE.callMounted([root, ...path], args)`.
- `IterateContextEntrypoint.callMounted()` runs in the parent worker, loads or
  reuses the mounted dynamic worker, awaits intermediate targets, and invokes
  the final method there.

## Preserve Receivers

When a mount target path ends in a method, call it on its parent object:

```ts
parent[method](...args);
```

Do not pull the function off and call it later, because Workers RPC /
WorkerEntrypoint methods may depend on their receiver.

## Mount Prototypes Are Per Instance

Runtime mounts are installed on a prototype created for one `IterateContext`
instance. Do not mutate `IterateContext.prototype`. One context's mounted
methods must not leak into another context.

## Project Connections Need Lifetime Ownership

`project.provideCapability({ connectionKey, rpcTarget })` publishes a live
Cap'n Web target through the existing project session. The project stores a
duplicate of the received stub so `project.connections.get(connectionKey)` can
return it later from Node, `/run`, or other context code.

The provider's Cap'n Web session must stay open while the registered capability
is expected to be callable.

The duplication is important in both directions:

- store `input.rpcTarget.dup()` when registering the capability;
- return `connection.target.dup()` when a caller borrows it.

Otherwise disposal of the call argument or a borrowed handle can close the
registered target for later callers.

## Project Ingress Returns The Project Capability

`/__iterate/capnweb` returns `ProjectCapability`, not `IterateContext`. A caller
that wants context-shaped calls uses:

```ts
using project = await connectToProjectCapnweb("/__iterate/capnweb");
using ctx = await project.getIterateContext();
```

Dispose the derived context handle before disposing the project/root WebSocket
handle.

## Project Worker Is A Facade

`ctx.project.worker` must not expose the raw iterate-config dynamic worker
entrypoint. It is a parent-owned facade:

- `ctx.project.worker.fetch(request)` forwards to project fetch behavior.
- `ctx.project.worker.someTool(args)` forwards to
  `project.callConfigWorkerFunction({ functionName: "someTool", args })`.

## SDK Paths Are Marker-Only

`liftLocalProxies(...)` must not broadly replace every returned object/function.
Only objects returned by `localProxyCaller(...)` become local SDK path proxies.
Normal Cap'n Web and Workers RPC stubs already have their own proxy behavior and
must pass through untouched.

## Vitest-Lowered `using` Is Test Serialization

Workerd supports native `using` for the `/run` compatibility date. If Vitest
lowers `using` before `fn.toString()`, the serialized function may reference
`__using` and `__callDispose` without including their module-level definitions.

Do not put those helpers in `/run`. The e2e helper repairs lowered function
strings before posting them to `/run`.

## E2E Helper Routes Must Be App-Owned

The local Cloudflare dev server reserves `/__debug`, so JSON helper routes under
that path can return devtools HTML before the Worker fetch handler sees the
request.

Use app-owned helper routes such as `/api/captnweb/egress-echo`. When local e2e
uses `APP_CONFIG_BASE_URL=http://127.0.0.1:5173`, worker-to-worker egress should
target a deployed/dev tunnel through `OS_E2E_EGRESS_ECHO_BASE_URL`.

## Some Failures Are Below The Context Model

Project setup can fail below Cap'n Web/IterateContext when the local Worker
runtime calls external bindings such as Cloudflare Artifacts or Captun-backed
tunnels. If project CRUD, streams, and mount dispatch still pass, diagnose those
binding/tunnel failures separately before changing the context model.

## Built-In Roots Are Not User Mounts

`ctx.projects`, `ctx.project`, `ctx.streams`, `ctx.repos`, `ctx.workspace`, and
`ctx.worker` are built-in roots derived from scopes. They must not be expressed
as user mounts, because mounts are execution-local shortcuts and custom targets,
not authority grants.
