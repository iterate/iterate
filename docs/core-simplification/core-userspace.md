# Core and user-space boundary

The active core is deliberately small. A context has an ordered event log and an `itx` namespace. It can append, read, wait, subscribe, invoke, fetch, and `cd`; a jail is the existing `itx => null` inheritance boundary. `provide` and a live `subscribe` callback use the same pager and Cap’n Web stub lifecycle. Processors, facets, and workers are ordinary code composed above that surface.

`itx.builtins` remains private platform assembly. Project and global contexts can assemble different trusted bindings; untrusted loaded code receives only its filtered `itx`. This is a factory and invocation-boundary concern, not a public kind system. Do not introduce a descriptor registry, target taxonomy, provider protocol, or compatibility migration to describe it.

Descriptions should stay lightweight: a name, prose, and optional TypeScript declaration supplied by the owner. `unknown` is valid. TypeScript is erased and Cap’n Web values are not a reflection schema, so descriptions must not become a runtime schema engine.

The important implementation constraint is to keep each policy once: private factory wiring owns platform bindings; the resolver owns existing expression, `cd`, and jail behaviour; the pager owns live borrow/page/redial/disposal; the durable runner owns durable progress. A change is worthwhile only when it removes duplicate ownership without changing processor authoring, React hooks, or the vanilla Iterate Cap’n Web client.

Agents, Voice, Garple policy, webhooks, and app-specific state belong in workers, facets, processors, and packages. They use ordinary events and `itx`; they do not need a core agent or capability-host abstraction.

For the earlier rejected typed-registry proposal and its source references, see [archived-core-userspace-first-design.md](archived-core-userspace-first-design.md).
