---
state: in-progress
priority: low
size: large
dependsOn: []
---

# Dynamic Workers and dispatch namespaces

Dynamic Worker fetch/RPC is implemented for default and named entrypoints with
inline JavaScript source. The remaining scope is dispatch namespace support and
the larger Dynamic Worker capability surface.

Keep the current schema shape for now:

```ts
via: {
  type: "env-binding";
  bindingType: "dynamic-worker";
  workerLoaderBindingName?: string;
  workerCode: WorkerCodeSubset;
}
```

This is slightly less Cloudflare-literal than `bindingType: "worker-loader"`,
because the actual env binding is the Worker Loader and the Dynamic Worker is
what that loader returns. The current names make the callable's eventual
invocation target clear while `workerLoaderBindingName` keeps the resolver
honest about which binding is used. Revisit only if this keeps confusing real
callers.

Implemented:

- Dynamic Worker fetch
- Dynamic Worker RPC
- optional `loader: { type: "get", id }` for Worker Loader `get()`
- strict inline JS-only code shape: compatibility date, main module, modules
- shared dispatch path after resolving the Dynamic Worker entrypoint
- named Dynamic Worker entrypoint selection
- Dynamic Worker entrypoint `props`

Deferred:

- dispatch namespace fetch
- source refs / CIDs / content hashes instead of inline source
- egress/globalOutbound policy
- derive or validate `loader.id` from a canonical WorkerCode hash
- `env`, tails, typed module objects, Python modules
- Durable Object facets
- Dynamic Worker WebSocket-specific test coverage, if we find a clean way to
  avoid additional workerd teardown noise

References:

- https://developers.cloudflare.com/dynamic-workers/api-reference/
