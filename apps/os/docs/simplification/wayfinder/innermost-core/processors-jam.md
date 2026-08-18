# Processors jam v4 — THE SUBSCRIPTION TABLE

v4 after eleven annotations on v3. The center of gravity moved: the owner asked to see **the
exact table** — "we've got different kinds of subscribers; they all need to consume events from
the stream" — and suggested the missing concept is inbound connections ("only nudge the
processor if the processor's inbound connection currently doesn't exist"). v4 is that model,
made explicit, with his hard requirements folded in. Decisions banked this round: **the SDK is
TypeScript** (prebuilt; apps/os-style proper bundling later); the apps/os-**verbatim** doctrine
is relaxed ("I'm not sure we need to verbatim anything from apps/os"); and terminology fixed —
**a facet hosts a durable object** (a DO class instance with its own storage), not a vague
"object".

## The requirements (owner, verbatim intent — the design must satisfy these)

- **Extremely low latency and high throughput** on the append→subscriber path.
- **In order. At-least-once is fine** (occasional double delivery ⇒ every side effect is
  idempotent — the contract already requires this). **Never wait for an acknowledgement** —
  acks confirm cursors asynchronously; they never block the commit or the next push.
- **Dispose every push's RPC stub/promise** (the apps/os pattern that is "super important to
  retain" — undisposed per-push promises leak the capnweb export table; we already have the
  one shared `disposeStub`).
- The commit path never head-of-line blocks on any subscriber.

## ONE table: subscriptions

Every consumer of the stream is a row. A row is `{name, target, delivery, consumes?}` — the
target is an itx expression, and `delivery` is one of exactly two modes. Concretely, one
stream's table might read:

| name              | target (itx expression)                                                                          | delivery | cursor lives                    | consumes       |
| ----------------- | ------------------------------------------------------------------------------------------------ | -------- | ------------------------------- | -------------- |
| `browser:jonas`   | `itx.clients.get('conn-7f3')`                                                                    | **push** | on the row (confirmed: 4021)    | `*`            |
| `tally`           | `itx.facets.get('tally')`                                                                        | **wake** | in the subscriber's own storage | `*`            |
| `iterate-context` | `itx.facets.get('iterate-context')`                                                              | **wake** | subscriber's own                | `*`            |
| `heavy`           | `itx.workers.get({ type: 'stateful', source: itx.files.read('/heavy.js'), className: 'Heavy' })` | **wake** | subscriber's own                | `*`            |
| `digest`          | `itx.workers.get({ type: 'stateless', source: itx.files.read('/digest.js') })`                   | **push** | on the row (confirmed: 4019)    | `chat/message` |

- **push** — for subscribers that cannot hold a cursor (a browser tab rendering the stream; a
  **userspace stateless worker that just happens to export a `processEvent` function** — the
  owner's always-include example). The stream owns the row's durable confirmed cursor. After a
  commit it pipelines in-order batches into the resolved target (`target.processEvent(batch)`),
  does NOT await, disposes each push's returned promise, and advances the confirmed cursor when
  acks arrive asynchronously. A failed/never-acked push redelivers from the confirmed cursor —
  at-least-once, in-order, zero blocking.
- **wake** — for subscribers that own a cursor in their own durable storage (facet processors;
  a remote DO processor). The nudge carries NOTHING; the subscriber reads contiguously from its
  own cursor through the log (the cursor-driven discipline we already run). Delivery can never
  be lost, only late — a dropped nudge is healed by the next commit or the next read.

**Answering "shouldn't we only nudge if there's no connected subscriber?"** — split by mode.
For push rows the question dissolves: the live inbound connection (the parked stub) IS the
delivery path; there is no separate nudge. For wake rows it is right for REMOTE subscribers
(if the subscriber currently holds a live inbound connection, push-style notification down
that connection beats a cold cross-machine wake; nudge only when it doesn't) — and unnecessary
for facets: a facet is in-process, an "inbound connection" to it cannot exist, and the nudge
costs roughly a method call, so facets are nudged on every commit unconditionally.

**Answering "does `wake()` need to exist? is it just forcing the DO into an isolate?"** —
mechanically that is nearly all it does: load the facet's durable object and trigger its
catch-up loop. Its reason to exist is _side-effect latency_, not correctness: folds are also
caught up lazily by any read, so a processor nobody reads would still be correct — but its
`processEvent` obligations (send the Slack message, move the robot) would wait until someone
happened to look. The nudge bounds that staleness to ~zero. Correctness NEVER depends on a
nudge arriving.

**`enableProcessor` dissolves.** Enrolling as a processor is not a special thing — it is a
wake-mode subscription whose target happens to be a facet (annotation 4). `enableProcessor
('tally')` becomes sugar for `subscribe({name: 'tally', target: "itx.facets.get('tally')",
delivery: 'wake'})` plus the facet materialization. The separate facet-processors table dies
into the subscription table. Browser rendering = `subscribe` with a push target of the
client's parked stub. One verb, one table, every consumer kind.

**Where the table lives (explicit, was fuzzy):** rows are ordinary events
(`subscription-added` / `subscription-removed`, replace-by-name), folded into iterate-context
state exactly like mounts — auditable, replayable, consistent with everything else. The parent
keeps a tiny derived index of the current rows in its kv (refreshed on each fold) because the
post-commit fan-out is the hot path and must not RPC into the facet to learn who to notify.
Derived index, not a second source of truth. (Open question 3 if this smells wrong.)

## The two doors into a facet (annotation 5 — fetch was missing)

1. **`facetInvoke(slug, path, args)`** — the RPC walk, parent-local because facet stubs are
   non-transferable (the DataCloneError learning); `stepGet`-guarded, terminal `Reflect.apply`.
2. **`fetch`** — the parent's existing native forward (`x-itx-cap` → `facet.fetch`), which
   tunnels WebSocket 101 upgrades. You fetch the Stream DO; it hands the request natively to
   the addressed facet. Already built and proven; v3 under-billed it as a footnote — it is the
   second door, co-equal, and it is how a facet serves a page or a socket.

`roots.facets.get(slug)` + the seed `itx.facets ⇒ roots.facets` ride door 1 for calls and door
2 for terminal-`fetch` expressions. (On the name `roots` itself the owner remains unsure —
noted as open question 4; the _behavior_ — a host-only vocabulary event-provenance expressions
cannot spell — is not in question, only what it's called.)

## Grammar fix (annotation 7): sub-expressions as call arguments

`['itx','files',['read','/heavy.js']]` inside a target was the structured half smuggling a
nested expression because the string grammar had no way to spell it. It should simply be:

```
itx.workers.get({ type: 'stateful', source: itx.files.read('/heavy.js'), className: 'Heavy' })
```

The fix is small and principled: the argument grammar admits dotted expressions as values,
with **ordinary call-by-value semantics** — evaluate the argument expression first, pass its
result. Rows store the unevaluated form (expressions are names; evaluation happens per
resolve). The op-set does not grow — still get + call + hole; only what may appear as an
argument does. Unambiguous to parse (an identifier start is not a JSON5 literal start).

## Verbs, restated plainly (annotation 3)

- **Author surface — the main verbs, unchanged:** `reduce` (pure fold) and `processEvent`
  (side effects, with `blockProcessorWhile`/`runInBackground`). This is what you write; it is
  the whole job description.
- **Runner internals** (the SDK base class, invisible to authors): the cursor, the five rules,
  refold-on-version-bump, and `wake()`.
- **Read surface, now minimal:** `snapshot()` — and `waitUntilProcessed({offset})` as the one
  barrier verb for read-your-writes. `getRuntimeState` is dropped (it was apps/os mirroring;
  the verbatim doctrine is relaxed, and nothing here needs it). Reads reach a processor through
  its facet address: `itx.facets.get('tally').snapshot()`.

## Still standing (decided or unchanged)

- **The collapse:** registry → SDK base class; net ~−150 lines, −3 concepts; `deliver` → the
  mode-split above (`wake` nudges, `push` delivers); facet runner = host the durable object,
  forward the role verbs.
- **The SDK is TypeScript** (decided): mechanics stay TS, a minimal esbuild prebuild emits the
  injected module — the simplest thing that works on this branch; proper apps/os-style
  bundling when this graduates.
- **zod stays host-side**; userspace contracts take `initialState: () => State`.
- **Why facets are the default placement:** locality, subordinate lifecycle, co-hibernation,
  no identity protocol (a remote target IS its identity; `configure` is facet-runner
  bookkeeping authors never see).

## Increment plan v4

1. **Collapse + SDK (TS prebuild) + renames** — as before, minus any `deliver` naming.
2. **The subscription table** — rows as events + the parent's derived index; `subscribe` /
   `unsubscribe` verbs; `enableProcessor` becomes sugar; push mode with pipelined no-ack
   delivery + per-push disposal + confirmed-cursor redelivery; live proof: a browser-shaped
   push row and the stateless `processEvent` worker consuming side by side with the tally
   facet.
3. **The facet address** — `facetInvoke` + the fetch door, `roots.facets`, the seed; proof: a
   facet with a normal RPC method invoked/aliased/shadowed through the table.
4. **Grammar: sub-expressions as arguments** — parser + substitute + tests.
5. **Deferred:** remote wake rows with connection-aware nudging (built when a real remote
   processor exists; the row shape is ready above).

## Open questions v4

1. Go on increments 1–4?
2. Push-mode receiving verb: is `processEvent(batch)` the one convention for every push target
   (browser-provided capability and stateless worker alike)?
3. Rows-as-events + parent-side derived index for the hot path — right call, or should rows
   live only in parent kv (operational wiring, not grants)?
4. The name `roots` (owner unsure): keep, or rename the host-only vocabulary — candidates
   welcome; behavior is settled, only the word is open.
5. ITX vs STREAM as caller-visible concepts (owner explicitly undecided): v4 keeps one context
   = one stream and spells addresses `itx.facets…`; revisit if sub-streams arrive.
