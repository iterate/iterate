# The layers — what's built on what

Plain-language map of the concepts in this package, bottom-up. Each layer only uses the ones
below it. Written to answer: "provide capability vs stream subscription vs live-state
subscription — which is an example of which?"

## Layer 1 — things you can call, and how they come back after a restart

Every callable thing in this system is one of four kinds. All four are the same idea: **a live
object plus a small piece of data that gets you the object back later.**

| Kind                       | The small piece of data           | Who rebuilds it                                                       | Where                                                       |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Durable Object by name     | its codec name (`prj_x.iterate/`) | Cloudflare (`getByName`)                                              | stream-durable-object.ts, stateful-worker-durable-object.ts |
| Worker entrypoint by props | the props object                  | Cloudflare (`ctx.exports`, persistent stubs)                          | iterate-context-entrypoint.ts                               |
| Loaded isolate             | cacheKey + source modules         | Cloudflare (Worker Loader)                                            | core/agent-runtime.ts `confinedWorker`                      |
| Parked client stub         | a socketId                        | **us** — wake the relay over its pager socket, borrow a fresh RPC leg | core/hibernatable-stub.ts, core/hibernatable-pager.ts       |

The first three are Cloudflare features. The fourth is ours, and it is deliberately the weak
one: a browser's callback cannot be rebuilt from data — our "rebuild" only works while the
client is still connected. When its socket dies, the callable dies. Everything above this
layer treats all four kinds identically.

## Layer 2 — expressions: writing a callable (or a call) down as data

core/expression.ts. One grammar, two interchangeable spellings (string and JSON).
`itx.clients.get('abc').notify(?)` is **data** that, when evaluated against a scope, walks to
one of the Layer-1 callables and calls it.

The key property: an expression stores no authority. Every evaluation re-derives everything
from the scope it is handed, so deleting a stored expression IS revocation.

The scope's roots (roots-builder.ts) are where expressions bottom out: `kv`, `stream`,
`contexts`, `clients`, `facets`, `workers`, `bindings`, `secrets`, `repo`, `files`, `whoami`.
Notice the repeating shape — most roots are pools with the same one-method API,
**`get(small piece of data) → callable`**:

- `clients.get(socketId)` → a parked client stub
- `facets.get(slug)` → a colocated processor
- `workers.get({source, className?})` → a loaded isolate or a stateful DO
- `contexts.get(path)` → a sibling stream

That is Layer 1's "data → callable" idea showing through, once per pool.

## Layer 3 — the stream: facts, plus the stream's own opinion of them

stream-durable-object.ts. `append`/`read`: one offset sequence, idempotency, ephemerals. Plus
the **inline folds** — state the stream derives from its own log synchronously inside the
commit (the routing table, and core-processor.ts's pause + circuit breaker). Enforcement
(refusing a paused or breaker-tripped append) lives here because the commit point is the only
place it can.

## Layer 4 — capabilities: durable names for expressions

iterate-context-stream-processor.ts. A **capability is a row** in the routing table: "calls
that look like P run T instead", where P and T are expressions. The table is a fold of two
event types (capability-provided / capability-revoked), so rows shadow, revoke, replay, and
audit like every other event-sourced fact.

- `provideCapability` = append the row event
- `revoke` = append the pop event
- `invoke` = match the call against the rows, substitute the caller's args, evaluate the
  winner's target (Layer 2), replay the unmatched remainder

Layer 1 gives you callables; Layer 2 writes them down; Layer 4 gives the written-down form a
**durable, shadowable name** that other calls route through.

## Layer 5 — processors: things that read the log and keep state (pull)

core/processor.ts. One authoring surface (`defineProcessorContract` + `reduce`, optionally
`processEvent`), three places to run:

- **inline** in the parent — reduce-only folds, zero machinery (the routing table and the core
  processor are themselves inline processors);
- a **facet** — the full async runner (serial chain, cursor, gap repair), own storage,
  independent abort (processor-facet.ts);
- a **loader isolate** — the same runner around userspace code (runner-entry.ts).

## Layer 6 — subscriptions: the stream calling out (push)

**Subscribe IS provide.** `subscribe({name, target, ...policy})` appends the very same
capability-provided event, at the reserved pattern `itx.subscribers.<name>`, with the delivery
policy riding on the event. Unsubscribe is revoke. There is no separate subscription store —
the push rows the pump uses are read straight out of the routing table.

What the policy adds is **who calls**. A plain capability is only ever called by callers. A
subscription row is called by the stream itself when events commit. The flavors differ only in
what happens when a delivery fails:

- **event subscriptions** — the stream keeps a cursor and a retry ladder, because history must
  be complete;
- **live-state subscriptions** — no cursor, no retries: change events carry delta patches on
  the producer's revision chain, and a client that misses one re-reads the producer's door.
  The present is re-askable; history is not;
- **no policy at all** — the degenerate case: a capability the stream never calls.

## Layer 7 — the edge: where live client objects enter

worker.ts + core/itx-surface.ts. capnweb terminates at `/api` and nowhere else. `Itx` is
dotted sugar that compiles method calls into Layer-2 expressions. When a client hands us a
**live callback**, the edge does one two-step — **park + alias**: park the stub (Layer 1,
minting a socketId) and provide `pattern → itx.clients.get(socketId)` (Layer 4). That is how
live things enter the durable world.

## The whole thing in one paragraph

Cloudflare gives us callables that come back from a small piece of data; expressions are the
one notation for writing those down; the log records facts and folds its own operational
truth at the commit point; capabilities give expressions durable names; processors pull from
the log; subscriptions are capabilities the stream itself pushes into; and the edge turns live
client objects into all of the above with park + alias.

## Direct answers to the layering questions

- **Is subscribe implemented in terms of provide/revoke?** Yes, literally — it appends the
  same event with a policy field, and unsubscribe calls revoke. Plus the pump machinery that
  does the calling.
- **Are provide and subscribe both examples of a hibernatable stub?** No. Their common parent
  is the **row** (a named expression). A stub only appears if the row's target happens to
  point at a live client; a subscription targeting `itx.digest.run` never touches one.
- **Is the hibernatable stub a sibling of entrypoint-from-props and DO-from-name?** Yes,
  exactly — four siblings, one idea (callable + small rebuild data), and the expression is the
  uniform notation for the "small data". The parked stub is the sibling with the weakest
  guarantee: rebuildable only while its owner stays connected.

## Where the layering is still muddy (cleanup candidates)

1. **Park + alias is written twice** in itx-surface.ts (subscribe's live-callback branch and
   `provideCapability({type:"live"})`). One helper would make Layer 7's single job visible.
2. **The parent still speaks "push rows / push cursors" as if they were a store.** They are a
   derived view of the routing table since the inline-core move — vocabulary and comments can
   say so plainly (no behavior change).
3. **`subscribe`/`unsubscribe` on the DO are pure sugar** over provide/revoke and could live
   at the edge; only `resumeSubscription` (cursor surgery) is a real parent verb.
4. **The live-state `key` is a topic convention** between producer and subscriber that never
   appears in the routing table. That is fine — a topic is not a callable — but it is the one
   relationship the table does not name; worth knowing, not necessarily worth fixing.
5. **The five `stub*` parent verbs** (stubInvoke/stubFanOut/stubList/stubConnections/
   stubClose) are the clients pool's API spelled flat on the parent class. Cosmetic.
