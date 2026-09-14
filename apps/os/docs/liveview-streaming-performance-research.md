# LiveView lessons for server-owned streaming text

Implementation and measured results: [streaming performance decision](./streaming-performance.md).

Status: research report, 2026-09-10. Scope: the agent-feed live preview and
the generic `LiveState` transport on `simplify-browser-stream-sync`. This is
research, not an implementation decision.

## Finding

Phoenix LiveView is a useful model for _sparse, server-authoritative UI
updates_. It is **not** a model for character-suffix streaming. A changed
dynamic text value is sent as the complete new value. LiveView avoids work by
omitting unchanged template slots and keyed subtrees; it does not encode
`append("new suffix")` for a growing string.

Therefore, converting our `responseText` to an ordinary JavaScript array of
strings would not fix the present transport: `LiveState.diff` intentionally
treats arrays as opaque leaves, so each update replaces the whole array. A
keyed object can make the current generic structural diff smaller, but only
if no surrounding array or duplicate joined string is changed. It still does
not make React's rendering of all accumulated chunks free.

The recommended direction is a small, typed, append-only text operation for
the live preview, with a bounded snapshot/window for first paint and
reconnect. Keep ordinary `LiveState` structural patches for the rest of the
feed. Do not build a general virtual-DOM protocol or add a persistent
immutable-collection library just to solve this one data shape.

## Sources and version boundary

The starting article, ["Supercharge your app: latency and rendering
optimizations in Phoenix LiveView" (José Valim, 2023-10-17)](https://dashbit.co/blog/latency-rendering-liveview),
is an excellent explanation of the architecture as it existed through the
then-new client root-skipping optimisation. It describes historical use of
`morphdom`; it should not be read as a claim that every internal detail is
unchanged today.

Current-source claims below were checked from a source checkout of
[`phoenixframework/phoenix_live_view`](https://github.com/phoenixframework/phoenix_live_view)
at commit
[`8abf802751d9df2b1fb8bc5e6835e09e2faba978`](https://github.com/phoenixframework/phoenix_live_view/tree/8abf802751d9df2b1fb8bc5e6835e09e2faba978),
dated 2026-09-09. The published API docs currently identify version 1.2.11:
[`Phoenix.LiveView.Engine`](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.Engine.html).
Links to source below pin that commit.

## What LiveView actually does

### Static/dynamic rendering tree and change tracking

HEEx compiles a template into literal static segments and a dynamic function.
The dynamic function returns `nil` for an unchanged expression when its
`__changed__` assign information permits it. The engine documentation and
implementation establish the allowed dynamic shapes: iodata, `nil`, nested
rendered trees, comprehensions, and components.

- [Engine documentation in source](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/lib/phoenix_live_view/engine.ex#L105-L192)
- [Current public Engine documentation](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.Engine.html#module-tracking-changes)

The diff walker serializes a changed binary dynamic as that binary. It skips
an unchanged nested dynamic, but there is no comparison of old and new binary
contents and no suffix opcode.

- [Current binary dynamic handling](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/lib/phoenix_live_view/diff.ex#L607-L656)
- [Sparse dynamic-tree traversal](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/lib/phoenix_live_view/diff.ex#L423-L464)

Consequently, the LiveView equivalent of updating one counter next to a large
unchanged response is cheap; the equivalent of appending one token to one
large dynamic response string is not. The article's examples say exactly that
unchanged dynamic slots are omitted, rather than describing a text delta:
[change tracking](https://dashbit.co/blog/latency-rendering-liveview#optimization-3-change-tracking).

### Collections are a specialised protocol, not an array diff

For comprehensions, LiveView shares one static template and tracks each
entry. A HEEx `:key` changes tracking from positional to logical-keyed; the
official documentation warns that without it a prepend makes the collection
be sent again. Current code retains per-key previous prints, omits unchanged
entries, and has an explicit move representation.

- [Engine documentation on comprehensions and `:key`](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.Engine.html#module-comprehensions)
- [Keyed traversal and move/diff handling](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/lib/phoenix_live_view/diff.ex#L681-L796)
- [Client keyed merge](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/assets/js/phoenix_live_view/rendered.js#L170-L217)

`stream/4` is more specialised still: it sends insert/delete/reset metadata
for a DOM collection and can discard stream entries from server socket state
after rendering. It is appropriate for bounded, keyed rows, not for retaining
an indefinitely growing text value or providing a generic reliable text
stream.

- [Live stream representation and wire annotation](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/lib/phoenix_live_view/live_stream.ex#L1-L70)
- [Client stream DOM insertion](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/assets/js/phoenix_live_view/dom_patch.ts#L180-L275)

The lesson is to model the operation that happened. A keyed append log has a
sequence identity and append/trim semantics; it is not an array replacement
whose implementation happens to have a new final member.

### Client work is deliberately scoped

LiveView's client holds a merged render tree, then either patches affected
components or renders a containing HTML fragment and applies a DOM patch.
Unchanged component/root subtrees can be retained instead of reparsed and
traversed. That is why the article's claimed client-side speed-up concerns
_unchanged UI subtree work_, not an optimisation of a changed large text slot.

- [Current client diff merge](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/assets/js/phoenix_live_view/rendered.js#L116-L188)
- [Component-only versus full patch selection](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/assets/js/phoenix_live_view/view.ts#L973-L1027)
- [2023 article on root skipping and its measurement](https://dashbit.co/blog/latency-rendering-liveview#optimization-7-change-tracking-revisited)

React needs the equivalent discipline: live updates must preserve references
for unrelated feed rows, and the streaming row must not recreate or tokenize
all previous content for every append. Stable keys alone preserve DOM nodes;
they do not eliminate the render/reconciliation cost of constructing a large
new children array on every update.

### Rejoin and flow control

On LiveView join, the server creates a rendered mount payload and the client
creates a fresh `Rendered` tree. A pending diff from an earlier join is
discarded because it was computed against a different tree. It has no generic
patch replay/resume cursor for the old tree.

- [Server render/diff state and transport push](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/lib/phoenix_live_view/channel.ex#L1099-L1165)
- [Client discards pre-rejoin pending diffs](https://github.com/phoenixframework/phoenix_live_view/blob/8abf802751d9df2b1fb8bc5e6835e09e2faba978/assets/js/phoenix_live_view/view.ts#L1125-L1175)

There is also no general acknowledgement window that turns arbitrary frequent
diffs into bounded transport work: each non-empty server diff is pushed. A
stream `:limit` bounds DOM collection retention, not pending WebSocket bytes.
Our design must therefore retain its existing producer cadence/coalescing and
define its own bounded snapshot/reconnect rule.

## Current Iterate baseline

The branch already made the broad state transport structurally efficient when
producers retain object identity. [`diff.ts`](../../../packages/iterate/src/sdk/capnweb/live-state/diff.ts)
only descends into plain objects; arrays, strings, and other leaves are
replaced. [`engine.ts`](../../../packages/iterate/src/sdk/capnweb/live-state/engine.ts)
debounces and distributes one revisioned snapshot-or-patch line;
[`store.ts`](../../../packages/iterate/src/sdk/capnweb/live-state/store.ts) rejects
revision gaps by resubscribing.

That means the following live shape still does O(total accumulated text)
transport per flush:

```ts
{
  responseText: oldText + suffix;
}
```

and this does too, because it is an array leaf:

```ts
{
  responseWindows: [...oldWindows, suffix];
}
```

A plain-object chunk map changes the generic diff result for append-only
keys, provided `steps` and any duplicate growing strings do not replace the
parent path:

```ts
{ chunksBySequence: { "41": "old", "42": "suffix" } }
// patch: fields.chunksBySequence.fields["42"] = { set: "suffix" }
```

But it leaves two important costs. The browser must still receive a complete
snapshot after a reconnect, and a React render that maps all historical
chunks still performs O(number of chunks) JavaScript work each live commit.

The present agent path has all three growth forms: the reducer appends to
`responseText`, appends a `responseWindows` array, and appends to
`thinkingText` ([reducer](../../../packages/ui/src/components/events/agent-ui-reducer.ts)).
The feed processor presently applies a 64K UTF-16-unit preview budget and a
1 MB JSON payload guard ([feed processor](../src/domains/streams/feed-processor.ts)).
The pager separately forwards whole current state pages from the DO to a
worker-local live-state engine ([pager](../src/domains/live-state-pager.ts)).
Thus a browser-only diff improvement would leave the DO-to-relay path
quadratic during one long response.

The current prose renderer maps every reveal window and then splits each
window into token spans on every render; code rendering changes one growing
text child and runs a layout effect per update ([agent feed](../src/components/agent-feed.tsx)).
The reveal animation is visually useful, but its current representation can
make CPU and DOM-node count grow with the full preview.

## Applicable design options

### Recommended: typed append log beside ordinary live state

Introduce an explicit live-preview channel/value for each active LLM field:

```ts
type TextSnapshot = {
  epoch: string; // new request/lifetime identity
  firstSequence: number; // retained-window lower bound
  nextSequence: number;
  chunks: readonly { sequence: number; text: string }[];
  truncated: boolean;
};

type TextUpdate =
  | { type: "snapshot"; snapshot: TextSnapshot }
  | { type: "append"; epoch: string; fromSequence: number; chunks: readonly string[] }
  | { type: "trim"; epoch: string; firstSequence: number };
```

Requirements:

1. `append` is accepted only when `epoch` and `fromSequence` match the local
   value. Any gap, duplicate conflict, or epoch mismatch requests a snapshot.
2. Coalesce provider deltas before one `append`; never concatenate every old
   chunk simply to form the update.
3. Retain a byte- and/or chunk-bounded window. A snapshot is intentionally
   O(window) and labels truncation; durable feed records remain the complete
   source after settlement.
4. Carry the same protocol through DO → pager relay → browser. Replacing the
   browser-side patch while the pager sends full `state` pages retains the
   main repeated-copy cost.
5. On reconnect, install a snapshot, then use the existing durable
   `streamId`/`publicationOffset` handoff. Never merge an old epoch's appends
   into a new preview.

This is the small analogue of a LiveView stream: named append semantics,
stable identity, bounded retention, and an explicit resynchronisation
boundary. It does not make text durable or move agent reduction into the
browser.

### Lower-risk interim: a keyed plain-object chunk map

Represent only the current step's live windows as an immutable
`Record<sequence, string>` and ensure the enclosing feed state is also keyed
by activity/step id. This uses the current `LiveState.diff` without a generic
protocol change. It is viable only if the duplicate `responseText` is removed
from the live wire shape and the React view obtains joined text lazily for the
limited cases that require it.

It is weaker than the typed protocol: initial/reconnect snapshots are still
the full map; `drop`/window trimming needs a coordinated consumer rule; and
general structural patch application allocates along every changed object
path. Use it if a narrowly scoped patch is required first, but measure it
against the recommended design rather than assuming it solves streaming.

### Avoid

- **An ordinary array of strings.** It is explicitly a wholesale leaf in the
  current generic diff.
- **Only an immutable data-structure library.** Persistent maps make producer
  identity and copy costs better but do not define suffix semantics, relay
  propagation, reconnect recovery, or React rendering.
- **An unbounded keyed map.** It trades repeated bytes for an eventually huge
  snapshot, object graph, and React child list.
- **A generic LCS/string-diff algorithm.** Append is known from the event
  model; deriving it by scanning prior text adds CPU and has ambiguous repair
  semantics.

## React rendering rules for the implementation

1. Subscribe each live activity/step to the narrowest external-store slice.
   Preserve identity of every other activity and settled row so they do not
   render for a token append.
2. Use a stable chunk sequence as the React key. Render completed chunks with
   memoized chunk components; only the append tail should receive changed
   props. Avoid `windows.map(... window.split(...))` across history on every
   100–150 ms update.
3. Bound DOM work as well as wire state. For prose, animate at most a recent
   tail and render older preview text as a small number of plain text nodes;
   do not retain one span per lexical token indefinitely. For code, retain a
   bounded visible window and keep the existing tail-pinning behaviour.
4. Batch visual commits to the product's chosen cadence (the current source
   batches provider chunks). Do not create a render per provider token.
5. Treat the streamed preview as replaceable. When durable publication reaches
   the matching identity/offset, swap once to durable content and release the
   append store. This prevents live state from accumulating across turns.

## Benchmark and acceptance plan

Measure production-shaped operations before choosing the final representation.
The test fixture should stream at least 64K characters in realistic 150 ms
windows and include a reconnect midstream.

| Metric                                  | Required comparison                          | Expected result                                                                                                  |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Bytes DO → relay → browser              | existing full-text state versus candidate    | Candidate grows with new bytes, except bounded snapshots.                                                        |
| Serialized/parsed bytes and allocations | same fixture                                 | No repeated full-preview JSON per window.                                                                        |
| React commits and commit duration       | collapsed row, expanded prose, expanded code | Only active preview subtree commits; bounded p95/p99 over the whole stream.                                      |
| DOM nodes                               | start, 32K, 64K, post-settlement             | Bound is independent of full durable response length.                                                            |
| Reconnect                               | network interruption at several offsets      | Exact visible prefix after snapshot; no duplicate/missing chunks; durable handoff has no blank or double render. |
| Slow consumer                           | delay relay/browser application              | Coalescing remains bounded and observable; no silent unbounded queue.                                            |

Run React Doctor after implementation, but use its result as a structural
check, not performance proof. The acceptance proof is the benchmark plus a
preview deployment trace/log inspection that shows no unexplained errors,
state divergence, or runaway payload/queue behaviour.

## Decision summary

Borrow LiveView's _semantic_ ideas: stateful server authority, sparse
operations, stable identity, explicit snapshot boundaries, bounded history,
and client work restricted to the changed subtree. Do not imitate its
template/DOM protocol. For a known append stream, encode append explicitly;
for React, keep the live tail independently bounded and avoid rebuilding the
whole tokenized history every commit.

## Design revision: make append a constrained generic live-state capability

The recommended text-specific side channel is not required. A generic
`LiveState` append codec is preferable **if** it is deliberately narrower
than a general sequence-diff protocol:

- a branded, serializable immutable text/block value has a stable `epoch`, a
  bounded ordered block sequence, and append/trim/replace semantics;
- a patch may say `append` only when the producer knows the suffix, and falls
  back to `set` for correction or epoch replacement;
- positional arrays get only verified append/truncate/replace operations,
  not a guessed LCS, move, or arbitrary splice algorithm.

That retains one subscription, one client store, and the existing generic
revision-gap recovery. It must not try to infer append by calling
`next.startsWith(previous)` on arbitrary strings. That operation is O(old
text) per flush, can force string flattening, and makes a divergent committed
response an implicit, expensive special case. Existing reducer code also
copies `responseWindows` on each append, so an array append patch alone fixes
wire bytes but leaves producer work quadratic.

A small immutable block tree/vector materially improves the 64K–1MiB case
when it removes both scans and repeated array copies. Use coalesced blocks
(for example, the existing ~150 ms windows or a few KiB), rather than one
object per provider token: at 64K a prefix scan may benchmark acceptably in
isolation, but the tree avoids relying on that result and keeps the 1MiB case
from acquiring a size-dependent CPU cliff. The full snapshot is still
O(retained window); that is intentional and is why the retained window must
be bounded.

The parent/facet boundary can use that same generic snapshot-or-patch codec
without retained callbacks. The parent already knows that a hosted delivery
may have advanced a facet and currently calls `facet.liveState().get()` on
every refresh ([facet-lane pull](../src/domains/streams/stream-durable-object.ts)).
Replace the facet read door with `readSince({ epoch, revision })` backed by a
bounded `LiveState` patch history. The parent keeps one transient cursor and
mirror for each facet lane, receives a patch when contiguous, and receives a
snapshot on a cursor/epoch/history mismatch. It then emits the same
snapshot-or-patch frames on its hibernatable Pager socket.

This removes steady-state full facet RPC reads while retaining the current
ownership model: the parent makes finite reads only after its existing
delivery signal; it holds no facet callback; the Pager remains the only
long-lived hibernatable socket. On a parent incarnation change, the
in-memory cursor/mirror is intentionally lost and its first pull is a full
snapshot; it must send that snapshot to every surviving Pager before sending
later patches. This is directly analogous to LiveView's new rendered tree on
join, rather than attempting to merge a patch against a lost baseline.

There are four non-negotiable correctness conditions:

1. The facet history advances exactly when its live projection advances and
   retains enough patches for the parent refresh cadence. A missed signal or
   stale cursor returns a snapshot, never a plausible patch.
2. Parent pull, mirror apply, and Pager send are serialized per lane. An older
   pull must not overwrite a newer mirror; the current lane already has this
   ordering concern because it lacks a wire revision guard.
3. Pager frames carry an epoch and monotonic revision. A new socket receives a
   snapshot first; an old relay ignores frames from an abandoned socket; a gap
   causes a new dial/snapshot. This preserves hibernation with no retained
   RPC callback.
4. Codec negotiation occurs before a subscription/Pager line is established.
   A new client must request the capability; an old server or old client uses
   the current snapshot/`set` representation for that line. Do not send a
   new nested patch shape optimistically into a rolling-deploy peer that only
   understands `{ set }` and `{ fields, drop }`.

This makes the generic approach modestly more complex than a private text
channel, but it is the better abstraction if it is exercised by more than
this feed and its protocol has the strict fallback and snapshot rules above.
It would be a mistake to make every JSON array positionally diffable merely
to obtain append: that broad semantic surface needs a much larger test matrix
for edits, deletion, reordering, aliases, structural sharing, and deployed
version skew.
