# Kenton Varda’s primary-source principles relevant to Iterate

## What is the transferable object-capability model for `itx.builtins`, inheritance and jails?

### Takeaway

Treat a context API as a graph of explicit authority-bearing references, not a global service catalogue inferred from names. A context may project a convenient named root such as `itx.builtins`, but that root is privileged bootstrap authority and must be deliberately constructed, attenuated for children/jails, and revocable. Descriptions are useful as declarations and audit data; they must never be mistaken for authority or for trustworthy reflection of an arbitrary remote object graph.

### Cited Findings

- Cap’n Proto defines references to remote objects as first-class capabilities: holding a reference both designates the object and grants permission to invoke it. It warns that a string URL or custom reference record is insufficient because the RPC system must know every embedded reference in order to export it or change its permissions safely. [Cap’n Proto comparison article](https://capnproto.org/news/2014-06-17-capnproto-flatbuffers-sbe.html)
- Cap’n Proto’s RPC documentation says capability-based patterns largely reduce to object-oriented design patterns, but explicitly describes the capability as the authority. It distinguishes Level 1 live references from Level 2 persistent capabilities, for which the application must implement saving/restoring. [Cap’n Proto RPC design](https://capnproto.org/rpc.html)
- The Cap’n Proto persistent-capability schema says whether a capability is persistent is often orthogonal to its interface/type; not all capabilities can be saved; the application defines SturdyRef format; and a sealed reference may require an owner proof before restoration. [Persistent capability schema](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/persistent.capnp)
- The same schema says untrusted code must not receive raw persistent-reference bits when confinement is required, because it could save/restore them outside the intended policy. [Persistent capability schema](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/persistent.capnp)
- Sandstorm’s sharing model separates app-defined permission meanings from platform-managed sharing/revocation graph: the app filters requests by granted permissions and need not maintain a user database; revoking one delegation removes only authority that depended transitively on it. [Sandstorm delegation model](https://sandstorm.io/news/page13/)
- Sandstorm’s confinement argument is that an app should have no external communication until a user grants a specific permission. Its Powerbox represents granted powers as Cap’n Proto object references, so permission and routing travel together. [Kenton Varda, network-access confinement](https://sandstorm.io/news/2015-06-10-network-access-permission-android-vs-sandstorm)
- Kenton’s Workers bindings rationale likewise presents configured live objects as capabilities: bindings avoid exposing configuration credentials in source and avoid a broad URL/address namespace, improving both ergonomics and SSRF resistance. [Workers live-object bindings](https://blog.cloudflare.com/workers-environment-live-object-bindings/)
- The Cap’n Proto protocol source warns that a default/bootstrap capability is privileged and must not be blindly treated as public; it also states that runtime APIs should expose a callable object with the interface methods, rather than raw protocol capability descriptors. [Cap’n Proto RPC protocol](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/rpc.capnp)
- Cap’n Proto added a membrane framework expressly for MITM wrapping, revocation, transformation and related capability patterns; later history includes fixes for revocation dangling pointers and additions that wrap a pipeline as well as settled capabilities. [Cap’n Proto 0.6 release notes](https://capnproto.org/news/2017-05-01-capnproto-0.6-msvc-json-http-more.html), [pipeline membrane commit](https://github.com/capnproto/capnproto/commit/88a40a33c6bf5811c2101a99e572deff02fe46c5), [revocation fix commit](https://github.com/capnproto/capnproto/commit/e1072a59c3a76fa822302d0f2459ede05ae8f277)
- Current Cap’n Proto history adds `cap.debugInfo()` to dump the type of a capability and a `RevokerMembrane` helper; those are explicit protocol/library facilities, not JavaScript object enumeration. [debug-info commit](https://github.com/capnproto/capnproto/commit/78bd96cef23811ea899d8f60f3d43082152acb36), [revoker-membrane commit](https://github.com/capnproto/capnproto/commit/8b7e20815905797564fcfa84f3451bb9c944d2f7)

### Inferences

- Model `itx.builtins` as a _bootstrap projection_, built from a typed capability manifest plus the caller’s grants and jail policy, rather than the canonical store of every possible thing in a context. The manifest should separately say: stable name, method/value contract, authority class, persistence class, exposure rule, and descriptive documentation. The actual stub/reference is then the authority; the manifest is inspectable metadata.
- A child context should receive a membrane/projection, not a mutable copy of the parent’s builtin graph. Inheritance is an explicit allowlist of capabilities or attenuated wrappers. A jail is the same projection operation with fewer roots and possibly wrappers that reject/rewrite arguments; its policy must apply to pipelined calls too, reflecting the Cap’n Proto membrane history.
- Live providers and subscriptions should use declared `CapabilityContract`s. A `subscribe` callback is simply a remote capability whose contract includes `deliver`; it does not get a special security model. The implementation may share one lease/relay mechanism, while the manifest distinguishes it as ephemeral and non-restorable.
- Do not derive `describe()` by walking arbitrary methods or properties on a remote Cap’n Web/Workers stub. That risks exercising getters/call paths, cannot recover erased TypeScript types, and confuses untrusted remote behaviour with a trusted contract. Provider-declared metadata can be schema-validated and treated as untrusted input before becoming discoverable documentation.
- Authoritative builtin descriptions ought to be generated once from the same manifest used to construct the projection. This removes divergent hand-written expression docs and turns “what is in this context?” into a deterministic data projection.

### Gaps

- This is a design translation, not evidence that Iterate’s present path/rewrite format should be kept. Kenton’s sources establish authority, attenuation, persistence and revocation principles; they do not prescribe an `itx.*` string-expression syntax.
- Cap’n Proto schemas provide interface types because Cap’n Proto is schema-based. Cap’n Web deliberately has no schemas, so the manifest/validator layer is an Iterate product choice rather than a Cap’n Web reflection feature. [Cap’n Web announcement](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)

## Which lifetime, persistence and latency principles constrain a simplified core?

### Takeaway

Keep three facts separate in the core model: a live capability reference, a durable capability recipe/identity, and a description of the contract. Pipelining is essential for dependent calls and should survive wrapper layers. Disconnection is a normal semantic outcome, not a cue to retain stale stubs; recovery recreates capabilities from an explicit recipe where such recreation is meaningful.

### Cited Findings

- Kenton’s Cap’n Proto RPC documentation calls promise pipelining critical to object-oriented distributed interfaces: dependent operations can proceed without a round trip per intermediate reference. [Cap’n Proto RPC design](https://capnproto.org/rpc.html)
- The original promise-pipelining comparison explains that latency is unavoidable and that a dependent-call RPC model without pipelining should not succeed; pipeline calls target a capability expected to arrive in a prior result. [Kenton Varda, promise pipelining comparison](https://capnproto.org/news/2013-12-13-promise-pipelining-capnproto-vs-ice.html)
- Cap’n Proto treats streaming as a capability pattern rather than a bespoke primitive: a callback can be invoked repeatedly and the client can pipeline calls to it before the server has returned it. [Cap’n Proto 0.8 notes](https://capnproto.org/news/2020-04-23-capnproto-0.8.html)
- Cap’n Proto says a connection loss turns capabilities served by that connection into disconnected capabilities, subsequent calls throw `disconnected`, and when remote references disappear the remote object is closed. [Cap’n Proto RPC design](https://capnproto.org/rpc.html)
- Its protocol says clients normally handle a disconnected capability by releasing related capabilities and recreating them via SturdyRef restoration and/or the original creation calls; a second disconnection while rebuilding should be treated as overload. [Cap’n Proto RPC protocol](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/rpc.capnp)
- The protocol does not define persistent reference representation itself, because persistence and restoration are realm/application semantics. [Cap’n Proto RPC design](https://capnproto.org/rpc.html)
- Native Workers RPC applies comparable explicit lifetime rules: parameter stubs are disposed at call return unless duplicated, object results acquire disposers, and an RPC execution context may remain alive until exported stubs and their calls are released. [Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
- Cap’n Web carries the same practical discipline: its session stubs are broken permanently after WebSocket disconnect and recovery opens a new session and re-acquires capabilities; it does not reconnect automatically. [Cap’n Web WebSocket transport](https://github.com/cloudflare/capnweb/blob/main/packages/docs/src/content/docs/transports/websocket.md)
- Durable Objects serialize concurrent requests at one object and use input/output gates to make intuitive storage code correct, but Kenton distinguishes in-memory coordination from durable storage and explains why initialization and unawaited persistence can fail without runtime support. [Kenton Varda, Durable Objects concurrency](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- DO hibernation discards in-memory state. Hibernation requires no standard WebSocket API and no active outbound WebSocket/TCP connection; subsequent events rerun the constructor. [Cloudflare Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- Open workerd issue #6087 says runtime RPC targets do not survive a DO eviction/reconstruction and Cap’n Web listeners on a normal socket prevent hibernation. It remains an open issue, so it is evidence of a current platform boundary rather than a future guarantee. [workerd #6087](https://github.com/cloudflare/workerd/issues/6087)

### Inferences

- The core’s persistent state should hold events, capability declarations and restoration/reattachment recipes only when the owner explicitly supplies one. It must not serialize/pretend to serialize a live Cap’n Web callback, a native Workers RPC stub or a session-owned subscription.
- Give every capability contract an explicit lifetime mode: `durable` (reconstructed from stored state), `reconnectable` (stable logical key but needs a new authenticated provider session), or `session` (invalid after session close). Do not infer mode merely from method/interface shape; the Cap’n Proto design explicitly says persistence is often orthogonal to type.
- A provider registry can make a broken live provider observable as `unavailable` and run a bounded reattach procedure. It must not transparently retry a non-idempotent method after a `disconnected` result: rebuild/reacquire first, then let the caller decide whether its operation is safe to repeat.
- Preserve pipelining through inheritance/jail membranes. A wrapper that awaits materialization at every path step reintroduces the latency Kenton’s pipeline model exists to remove. This is a strong implementation constraint, but it does not require exposing raw internal stubs to user code.
- Subscriptions need a semantic cursor/checkpoint in durable state if “no gap” matters. The callback lease is only delivery transport and is lost on session failure; appending events and resuming from a cursor is the durable protocol.

### Gaps

- Kenton’s writing supplies the recovery model, not Iterate’s exact operation-level idempotency classification. That needs an Iterate-owned contract for append, fetch and provider calls.
- No source establishes that any generic static type can decide safe replay after a disconnect. Treating every expression call as idempotent would contradict the need for application-defined semantics.

## How should trusted and untrusted code, stateful facets and userspace features be layered?

### Takeaway

Put a tiny, trusted supervisor around narrowly granted capabilities; run product/agent code as untrusted and disposable; give persistent facets their own explicitly scoped state. This supports moving agents, voice and product integrations out of the core while keeping the core responsible for events, projection, lifecycle and transport adaptation.

### Cited Findings

- Kenton’s Dynamic Workers example grants generated code a particular RPC stub through `env`, can set `globalOutbound: null`, and presents the sandbox as isolated from the rest of the world except for the capabilities deliberately supplied. [Dynamic Workers announcement](https://blog.cloudflare.com/dynamic-workers/)
- The same article says on-demand generated code should not be `eval()`ed in the application and positions isolates as disposable task sandboxes. [Dynamic Workers announcement](https://blog.cloudflare.com/dynamic-workers/)
- Kenton’s Durable Object Facets design retains a normal supervisor DO, dynamically loads app code as a facet, and gives parent and facet separate SQLite databases stored in the same overall object; the facet cannot read the supervisor database. [Durable Object Facets announcement](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)
- The Facets article explicitly frames the supervisor as the layer for limits, tracking, observability, metrics and billing before forwarding work into application code. [Durable Object Facets announcement](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)
- Kenton’s workerd article describes capability bindings as a cleaner alternative to global address space and calls out that workerd alone is not a complete secure sandbox for malicious code: deployed Workers adds defence-in-depth around runtime and hardware vulnerabilities. [workerd announcement](https://blog.cloudflare.com/workerd-open-source-workers-runtime/)
- Kenton’s Workers security writing says isolates/processes/VMs do not alone solve side channels; security needs layered mitigations appropriate to the hosting environment. [Dynamic process isolation](https://blog.cloudflare.com/spectre-research-with-tu-graz/)
- Sandstorm’s identity refactor is a useful counterexample to over-unification: it says several distinct goals were “mashed together” into one identity model and were fundamentally different problems. [Kenton Varda, identity refactor](https://sandstorm.io/news/2017-05-08-refactoring-identities)
- Current Cap’n Web is intentionally schema-free and supports TypeScript ergonomics, not runtime truth; untrusted peers still need runtime validation at exposed boundaries. [Cap’n Web announcement](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)

### Inferences

- The minimal trusted Iterate kernel is: append/read/subscribe event mechanics, projection of an authority manifest into a context, durable-state/restore boundaries, and one Cloudflare live-transport adapter. The kernel owns audit-quality descriptions and opaque provider handles.
- Agents, voice, MCP/vendor libraries, fetched apps and dynamic worker code should be userspace facets/providers. They receive only their context projection and explicit `fetch`/tool/event capabilities. They cannot inspect hidden builtins, reach a global environment, or receive persistence/reference tokens outside the supervisor’s policy.
- A facet’s state should be a separate capability domain and database/storage namespace, as in the Facets design. Cross-facet work should happen through declared capabilities/events rather than shared internal tables or a broad `builtins` object.
- “Description” should have two layers: trusted platform-owned contract declarations for core builtins, and provider-supplied declarations that are validated, namespaced and labelled as provider claims. This gives tools/agents useful type-like guidance without converting documentation into ambient authority.
- Avoid a total rewrite merely to make every object into an object-capability object graph. Kenton’s work argues for capability references where authority crosses boundaries; ordinary local data, event records and declarative manifests remain values. The right cut is at trust, lifetime and placement boundaries.

### Gaps

- This review cannot establish whether every current Iterate agent/voice feature already fits a Dynamic Worker or DO Facet boundary. That requires the repository’s feature-level dependency and persistence audit.
- The cited Dynamic Worker and Facet posts describe Cloudflare product behaviour and architecture, not a formal guarantee that arbitrary user code or all third-party packages are safe. The platform source itself stresses defence in depth. [workerd announcement](https://blog.cloudflare.com/workerd-open-source-workers-runtime/)
