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

- rpc stubs of functions and rpc targets that are passed by reference as arguments into capnweb rpc methods need to be dup()-ed once in every isolate they pass through, if they are meant to not be disposed when the rpc call they came with returns
  - for example, itx.streams.get("/bla").subscribe({ processEventBatch: (batch) => { ... } }) needs to be dup()-ed once in the stateless worker that runs the StreamRpcTarget and then AGAIN inside the durable object isolate that holds the subscriptions. If this ever seems relevant, please research the capnweb and workers rpc docs about dup-ing
