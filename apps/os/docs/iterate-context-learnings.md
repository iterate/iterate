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

The admin `/api/captnweb/admin/run` path executes codemode-shaped snippets in a
dynamic Worker, but its response should always be plain JSON. Snippets may use
Cap'n Web / Workers RPC internally, but the snippet result must be serializable.

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

## Project config worker capabilities need a facade too

`ctx.project.worker` must not expose the raw dynamic worker entrypoint returned
by the Project Durable Object's loader. Calling `getConfigWorker()` across an
RPC boundary hits the same dynamic entrypoint transfer rule.

The workable shape is a parent-owned `ProjectWorkerCapability` facade:

- `ctx.project.worker.fetch(request)` forwards to project ingress/fetch.
- `ctx.project.worker.someTool(args)` forwards to a Project Durable Object method
  such as `callConfigWorkerFunction({ functionName: "someTool", args })`.

That keeps the config worker entrypoint inside the Project Durable Object.
