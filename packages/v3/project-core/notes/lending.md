# Live capability lending

`src/lending.ts` keeps capnweb's bidirectional capability primitive without
putting a session-bound value in a hibernatable Durable Object.

The edge holds the capnweb callback. A DO has only a native, hibernatable pager
WebSocket whose attachment is an opaque UUID key. On a call, the DO sends one
`{ type: "page", key }` frame. The edge creates a fresh Workers-RPC
`EdgeInvoker` and calls the private DO `lend({ key, invoker })` method. The DO
borrows that leg while work is active and calls:

```ts
invoker.call(["tool", "run"], [input]);
```

At the context's idle quiesce it calls `directory.releaseIdle()`, disposing all
borrowed legs. The pager attachment remains, so a later call wakes the DO and
pages the edge again. A socket close returns the borrowed leg and invokes the
directory's `onDetached(key)` callback, where the project host should remove
the owning capability/subscription record and append any audit fact.

## Public contracts

```ts
type LendingInvoker = RpcTarget & {
  call(path: string[], args: unknown[]): Promise<unknown>;
};

type LendingHost = {
  fetch(input, init?): Promise<Response>;
  lend({ key, invoker: LendingInvoker }): Promise<void>;
};

const directory = new LendingDirectory(this.ctx, (key) => this.detachLending(key));
```

The DO's fetch handler calls `directory.attach(request)` first. A defined
response handles only the private native upgrade. The edge calls `lend(host,
capnwebTarget, ctx.waitUntil)` and registers the returned disposable with its
capnweb session teardown. `lend` allocates the key with `crypto.randomUUID()`;
keys are not caller-chosen names and a second attached pager with the same key
is rejected. Public edge routing must remove `x-project-core-lending-pager`
before it selects a project/DO. The private DO `lend` method must never be
exposed through the public capnweb surface.

## Invariants and limits

- The callback remains at the edge. The DO holds no `RpcStub` between calls.
- `releaseIdle()` is part of the context's quiesce path, after in-flight work
  drains. Forgetting it pins the DO and is a correctness defect.
- Concurrent cold invokes of one key share one page promise. A duplicate lend
  is disposed and cannot replace the currently borrowed leg.
- Page wait is 10 seconds and the DO allows at most 64 distinct page waits.
  Timeouts, pager closes, and capnweb breakage become coded, observable
  `LENDING_OFFLINE` failures. The edge's asynchronous page handler catches and
  audits every failed lend.
- Callback traversal allows at most 16 normal property segments and rejects
  `__proto__`, `constructor`, and `prototype`; the final value must be a
  function. It intentionally does not parse an expression language.
- This module supports RPC calls only. Fetch/101 forwarding remains the single
  project fetch gate's native-fetch responsibility; a socket-bearing Response
  must not cross this Workers-RPC leg.

## Required deployed proof

The project-core preview suite should create two capnweb sessions: session A
lends an `echo` target and session B invokes it through the same context. Then
wait past idle, prove the DO reports no borrowed legs, invoke again and prove
one fresh page/lend reaches A. Repeat after a DO wake. Close A and prove B gets
`LENDING_OFFLINE`, the directory emits its detach callback once, and the host's
audit record explains the loss. Include a concurrency case with many B calls
after quiesce and assert one page request, plus malformed/duplicate pager
headers and a forbidden callback path.

The independent evidence for the protocol is the existing clean-room
implementation: `packages/v3/project-worker/src/context/rpc-stub-directory.ts`
and `rpc-stub-relay.ts`, particularly its pager attachment, page coalescing,
idle disposal, and session-break handling. This sibling intentionally removes
its generic expression parser, rewrite rows, pager-attached events, and
fetch-over-lent-stub workaround.

The underlying semantics are source-grounded rather than emulated: Cap'n Web's
`RpcStub.dup()` resets to a retained root stub and `onRpcBroken()` is the
disconnect hook (`/Users/jonastemplestein/src/github.com/cloudflare/capnweb/src/core.ts`,
`RpcStub` around lines 451--510). Its own documented Cloudflare OS usage says
to `dup()` a callback retained beyond the receiving call and remove it from
`onRpcBroken()` (`cloudflare-os/packages/workshop-backend/src/agent.ts`, around
619). Native Workers RPC turns an `RpcTarget` into a transferable stub; it is
disposed with `Symbol.dispose` (the generated Workers types, `Rpc.StubBase`,
and `workerd/src/workerd/api/worker-rpc.h`). Finally, `acceptWebSocket()` means
the DO receives messages through `webSocketMessage`/`webSocketClose`, and
closed sockets disappear from `getWebSockets()` (`workerd/src/workerd/api/actor-state.h`,
650--671). The directory uses precisely those lifecycle hooks.
