---
state: planned
priority: high
size: medium
dependsOn: []
---

# Capability policy

V1 validates shape but does not enforce access policy. Treat every Callable as
untrusted code: if a caller passes raw `ctx.env`, the JSON can name any
`env-binding.bindingName` present on that env object. If the caller passes raw
`ctx.exports`, the JSON can name any loopback export exposed there. Before
accepting tenant/user/LLM-authored Callables, add an explicit runtime policy.

The policy itself should be a function, not serialized JSON. Product code needs
to make policy decisions from runtime context: tenant, user, project, deployment
environment, and any host-owned auth state. We can provide builder helpers for
common allowlist policies, but those helpers should compile down to the same
function hook.

Suggested core shape:

```ts
type CallablePolicy = (options: {
  callable: Callable;
  attempt:
    | { type: "env-binding"; bindingType: string; bindingName: string }
    | { type: "loopback-binding"; bindingType: string; exportName: string }
    | { type: "public-fetch"; url: URL }
    | { type: "workers-rpc"; rpcMethod: string };
  ctx: CallableContext;
}) => void | Promise<void>;
```

Use `attempt`, not `resolved`: the hook is asked whether the runtime is allowed
to attempt a concrete authority use. It may run before the binding/stub/fetch is
actually resolved.

Builder helpers can stay ergonomic:

```ts
const policy = allowCallablePolicy({
  envBindings: {
    TOOLS: { fetch: true, rpcMethods: ["callTool", "listTools"] },
    TOOL_REGISTRY: { rpcMethods: ["listTools"] },
  },
  loopbackExports: ["Streams"],
  publicUrls: ["https://api.github.com"],
});
```

The dispatcher should call the hook at each real authority boundary:

- before resolving an env binding
- before resolving a loopback export
- before public URL fetch
- before Worker Loader `load()` / `get()`
- before invoking `rpcMethod`

Planned scope:

- allowed binding names
- allowed loopback export names
- allowed public URL via values
- allowed RPC methods per binding or via shape
- denied headers
- secret references instead of literal bearer tokens
- callable size limits
- template output limits
- a resolver API that avoids passing raw `env` to untrusted Callables
