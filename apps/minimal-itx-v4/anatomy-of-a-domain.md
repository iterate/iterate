Domains consist of one or more of

- dependency-free human-readable type declaration in types
- RpcTarget subclasses / capabilities that are available for `itx` callers
- Durable objects - generally with a `{projectId}:{path}` naming schema
- Stream processors - listening on

### How objects are created

Somebody calls

- `using itx = unauthenticatedItx.authenticate({ auth: { type: "token", token: "my-token" } }).projects.get("prj_123")`
- `itx.things.create({ name: "My thing" })`
- this calls `create()` on `ThingsRpcTarget` (which has a projectId of `prj_123`)
  - ThingsRpcTarget comes up with a thing id of `thing_123`
- this gets `env.THING.getByName("prj_123:/things/thing_123").create({ name: "My thing" })`
  - this appends a `events.iterate.com/thing/create-requested` event to the thing's stream and subscribes the processor to `{stream}` and waits for the `events.iterate.com/thing/created` event to be appended to the thing's stream
  - the thing's stream processor picks up the event, enacts side effects and appends a `events.iterate.com/thing/created` event to the thing's stream
  - `create()` then returns from the Durable Object

# Important considerations

- rpc stubs of functions and rpc targets need to be dup()-ed by the isolate that
  keeps them after the RPC method that received them returns. Transparent
  forwarding layers should pass arguments through. With Cloudflare Workers'
  `rpc_params_dup_stubs` behavior (default from compatibility date 2026-01-20),
  parameter stubs are duplicated while forwarding and match Cap'n Web's
  ownership model.
  - references:
    <https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/>,
    <https://developers.cloudflare.com/workers/configuration/compatibility-flags/#duplicate-stubs-in-rpc-params-instead-of-transferring-ownership>,
    <https://github.com/cloudflare/capnweb#cloudflare-workers-rpc-interoperability>
  - for example, `StreamRpcTarget.subscribe()` forwards `processEventBatch`
    directly to the Stream Durable Object. The Stream Durable Object retains the
    callback because it stores the subscription connection and calls the callback
    later. The stateless worker proxy does not retain or wrap it.
  - live `provideCapability()` targets follow the same rule: the ITX processor
    that stores the live capability must retain the stubs it will call later and
    dispose those retained stubs when the capability is replaced or revoked.
