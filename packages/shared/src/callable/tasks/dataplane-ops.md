---
state: planned
priority: low
size: large
dependsOn: []
---

# Dataplane operations

Keep Queue, Workflow, AI, Vectorize, D1, KV, and R2 out of v1, but treat them as
future Callable operation types rather than a separate system.

The intuition is the same as fetch and Workers RPC: serialized JSON names a
Cloudflare binding and an operation to perform through that binding. Under the
hood these platform bindings are still capability-bearing APIs exposed inside
Workers, so the callable policy/resolution story should apply to them too.

They should likely reuse the existing `via: { type: "env-binding", ... }`
pattern, adding binding types and operation-rooted callable types as needed:

```ts
type QueueSendCallable = {
  type: "queue-send";
  via: {
    type: "env-binding";
    bindingType: "queue";
    bindingName: string;
  };
  message?: JsonValue;
};

type KvGetCallable = {
  type: "kv-get";
  via: {
    type: "env-binding";
    bindingType: "kv-namespace";
    bindingName: string;
  };
  key: string;
};
```

Do not add a separate `Operation` abstraction unless the callable union becomes
too broad to explain. The current direction is that these are just more
Callable operation surfaces with Cloudflare binding via values.

Add them only when a real consumer needs stored JSON Callables for these
operations.
