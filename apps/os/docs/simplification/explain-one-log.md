# It is one log and a fold — a database turned inside out

_One of three parallel explanations of the iterate system. The maximalist
event-sourcing line: there is **one write and one read**, and everything else —
state, UI, RPC, even the LLM's mind — is a materialized view over an append-only
log. Lineage: Datomic, Kafka-as-a-database, event sourcing. The last section says
why this beats the sibling "intelligent entity runtime" and "operating system /
three rings" framings, and where it honestly breaks._

---

## 1. What it is, in one breath

**An iterate project is one append-only log per path, and everything you can
observe — state, screens, API replies, an agent's memory — is a fold of that
log recomputed on demand. There is exactly one write (append an event) and one
read (follow the log). A call is an append that doesn't stay; a workflow is one
that does.**

Expanding that: a normal application is a mutable database with a log bolted on
the side for audit. iterate is the same thing turned inside out — the **log is
the source of truth** and the database is the cache. This is not a metaphor in
this codebase; it is the storage model. When you append an event to a stream,
the stream assigns it an offset and it becomes an immutable fact forever
(`stream-durable-object.ts:201-322`, "Append: the commit point"). Every piece
of state anyone reads — an agent's conversation, the list of your projects, a
scheduler's next fire time, a secret's ciphertext — is produced by running a
pure reducer over those facts (`stream-processor.ts:417`, `reduce(...)`). Delete
the cache and the truth is untouched; the system deliberately throws its caches
away and rebuilds them from offset zero whenever the reducer's version changes
(`stream-processor.ts` discards schema-mismatched checkpoints and refolds). The
whole system is a database whose transaction log was promoted to be the
database, and whose tables were demoted to views.

That single move — log is truth, everything else is a view — is the entire
design. The rest of this document is just refusing to make an exception to it.

---

## 2. The three things you must know

Three claims. Each is a slogan plus plain sentences a working programmer already
owns. Glossary up front, because that is the discipline (§7.9): **log** = an
append-only list of events at a path. **event** = one immutable fact with a type
and a JSON payload. **fold** = run a function over the log left-to-right,
accumulating state (`Array.reduce`). **view** = anything computed from the log
(state, a screen, an API reply). **follow** = read the log, optionally waiting
for more.

### 2.1 There is one write: append. Retention is the only axis.

> **Everything durable is an append. The only question is whether it stays.**

You do not "update a row," "call a method that mutates," or "set a field." You
append an event. That is the sole write verb in the system, and it is a single
synchronous commit: offsets are assigned, storage is written, and the log's own
reducer runs — all in one turn that cannot be interrupted (`stream-durable-
object.ts:201-235`). After that turn the event is a permanent fact.

Because appending is the only write, the difference between things that feel
completely unlike each other collapses to **one axis: how long the event
stays.** A durable event stays forever and is the source of truth. An
*ephemeral* event is committed and offset-ordered exactly like a durable one,
but it is excluded from range reads, never delivered to durable followers, and
may be evicted later (`schemas.ts:58-73`). That single retention flag is the
whole difference between "a workflow step you can replay in five years" and "a
voice-audio frame you'll never look at again." Same verb, same log, one bit
different. Hold onto this: the crazy-corner insight that "a call is an append
that doesn't stay, a workflow is one that does" (§7.1) is not a poetic flourish
— it is literally this flag.

### 2.2 There is one read: follow. Duration is the only axis.

> **Everything alive is a follow. The only question is for how long.**

You do not "query a table" or "subscribe to a topic" as separate mechanisms. You
follow a log, and the only thing that changes is how long you keep following:

- follow **from zero to now, then stop** → you get *state* (a fold). This is
  every `list()`, every dashboard number, every "current value."
- follow **for a moment, waiting for one event** → `waitUntilEvent` (`stream-
  processor.ts:353-380`). This is how request/response is built: append the
  request, wait for the completion.
- follow **for a session** → a live subscription; you get events as they land.
- follow **forever, remembering where you got to** → a **processor**. A
  processor is nothing more than a follower that never stops and writes down its
  offset (`stream-processor.ts:512-542`, "write-before-advance").

There is no fifth thing. "Query," "subscribe," "workflow engine," "actor
mailbox," and "materialized view" are all the same act — follow a log — clocked
at different durations.

### 2.3 State is a fold, and every fold is a throwaway cache.

> **State is what a follower has understood so far.**

The database is not stored; it is *derived*. `state = reduce(events)`. The code
takes it literally: checkpoints (`{offset, state}` pairs saved next to the log)
are declared disposable caches, discarded and rebuilt from offset zero on any
reducer version bump. That is exactly Datomic's claim — **"the database is a
value," a pure function of the facts as-of any point in time** — and
Kafka-as-a-database's claim that **the log is primary and the tables are
projections**. iterate is those two papers compiled to a running system: state
is a *value* you recompute, not a *place* you mutate.

The payoff shows up everywhere: the browser runs the *same* reducers over an
OPFS SQLite mirror that the server runs, because a function can be evaluated
anywhere. "Sync" stops being a problem — there is nothing to sync, just one log
and many folds of it.

### 2.4 The LLM is a step whose output you write down.

> **An LLM is a reducer whose result you cannot re-derive — so you journal it,
> and replay reads it instead of recomputing it.**

Here is the one place where "state = reduce(events)" would break, and the exact
trick the code uses to keep it whole. An LLM is nondeterministic: fold the same
prompt twice, get two answers. If the model's output were *recomputed* on
replay, state would stop being a pure function of the log and the entire design
would collapse.

It doesn't, because the model's output is **journaled as a fact**. The agent
processor rebuilds the prompt by folding committed history up to an offset; the
request's identity *is* that offset; the settled answer is appended as its own
durable event (`agent/output-added`). Replay **reads** that event; it never
re-calls the model. A deterministic fold over a history that happens to contain
nondeterministic *facts* is still deterministic. Streaming tokens ride the
ephemeral lane (§2.1), superseded by the one durable `output-added`
(`schemas.ts:66-68` names this exact case). So the LLM slots into the reducer
position without breaking replay — its "mind" is a fold, its thoughts are
addressable offsets. This is the whole basis for "any coding agent — claude,
codex, pi, opencode — is a stateful stream processor" (§6.1): all reducers with
a stochastic step, given the persistent replayable memory their own
architectures fake with files.

---

## 3. The 5,000-LOC core, structured

If you accept "one log, one fold," the core is small and has an obvious shape.
It is not "33 capabilities." It is **four engines**: the thing that stores the
log, the thing that folds it, the thing that delivers it to followers, and the
one door bytes cross. Everything else in `apps/os` — all 33 root members, all
63k lines of `domains/` — is a *view* built from these four, or a package, or
deletion.

I am the maximalist, so I will say the strong thing plainly: **streams are the
whole core.** Not one domain among many — the substance. Every other domain is a
particular reducer with a particular set of appends. The audit already proved
this descriptively: of the 35 members on the front door, the honest classes are
"the journal," "folds," "appends wearing RPC clothing," and a short list of
justified effectors (Appendix A §1). The core is those four families made
literal.

Here is the budget, taking the §5 collapses as done. Numbers are src lines,
tests excluded, and they are honestly counted — this lands near 5k, not exactly
at it, and the residual is real work not padding.

| Engine | What it is | LOC | Collapses that get it there |
|---|---|---:|---|
| **The log engine** | Append (the one synchronous commit point), read, offset assignment, idempotency, ephemeral retention, birth certificate. The `StreamDurableObject` — but folding *on the one processor engine* instead of its own hand-rolled twin. | ~900 | §5.3: the stream's private 290-line reduce switch dies; the log folds on the same engine everything else does |
| **The fold engine** | The processor: `reduce` (pure fold), `processEvent` (keyed side effects), `reconcile` (obligations at head), plus contracts and the one obligation primitive. | ~1,400 | §5.4: one `Obligation` primitive absorbs keepalive revival + the spine's backoff/park — three durability machines become one |
| **The delivery engine** | One durable follow: stream-owned cursor, at-least-once, ack-advances-cursor, backoff→park. The browser follows on the *same* lane. | ~800 | §5.5: four delivery lanes (wake/push/webhook/browser) collapse to one; ~1,000 lines of browser "transport necromancy" (epochs, fencing, liveness probes) deleted |
| **The one door** | `fetch`. Internal hostname → routes inside the project, ungated. External origin → the egress gate: secret substitution, allowlist, human approval, audit. | ~700 | §5.9 + §6.11: two fetch doors become one; one secret substitution parse instead of two; vendor SDKs stop bypassing the door |
| **Auth + confinement + expression eval** | Identity, per-project confinement, and evaluating the quoted-call grammar (mounts, subscription targets — all folds of the log). | ~1,300 | §5.8: expressions resolve against a folded snapshot in-isolate; 6 hops → 2-3; one path-walk, one reserved-segment set |
| **Repo (log of commits) + build/load** | Git is itself an append-only Merkle log; the config worker is loaded from it. Durable HEAD, builds in the sandbox. | ~900 | §5.6: three "where code lives" answers (repo / workspace / container) collapse to two, no clone-per-write, no circular wiring |
| **Total** | | **~6,000** | |

Two things to notice. First, **`rpc-targets.ts` (6,014 lines) is not in this
table at all.** That entire file is the parallel dispatch civilization the log
made unnecessary: a mount is a fold of `capability-provided` events, a `list()`
is a fold read, `agents.message()` is an append, `secrets.update()` is an
append with ciphertext in the payload (`secret/updated`), `scheduler.set()` is
an append (Appendix A §1, members 4/21/28/26). Once you say "everything callable
is an append or a fold," `rpc-targets.ts` shrinks toward the four nouns its own
header names, and the 5,270 lines of *generated* artifacts that exist only to
make hand-written code agent-legible go with it.

Second, the log engine got *smaller*, not larger, by absorbing the stream's own
control logic. Today the platform's central concept has two implementations: the
generic processor engine every domain uses, and a hand-rolled twin inside the
stream DO that folds 15 `stream/*` control events with its own checkpoint
debounce and its own wait primitive (§5.3). "Everything is stream processing"
is contradicted by the stream itself not using the processor engine. Fix that
and the core is *one* fold engine, hosted by the log, folding its own control
events like any other reducer folds its own.

The slogan the numbers support: **if a file doesn't implement append, follow,
fold, or the door, it's a view or a package.**

---

## 4. The API

The whole API is three verbs, and two of the three are the "one write, one read"
you already know.

```ts
// The two that matter, plus login and the door.
interface Kernel {
  authenticate(credentials): Scope;              // log in → a project-confined scope

  append(path, events): Promise<{ offset }>;     // THE WRITE
  follow(path, opts?): Events | State;           // THE READ (read, wait, subscribe, or fold)

  fetch(req): Promise<Response>;                  // internal = free; external = the one gate
}
```

Everything else is a **derived form** — sugar spelled in `append` and `follow`:

```
subscribe  = append("stream/subscription-configured", { target })  // make the kernel follow for you
mount      = append("capability-provided", { at, expression })     // a quoted call, stored
call       = append(ephemeral "invocation-requested") + follow-until-"completed"
obligation = append(durable "…-requested") + kernel follows until terminal-or-expiry
birth      = the first append to a virgin path; its TYPE arms the followers
state      = follow-from-zero with a reducer
```

Read that list again and notice what it is saying: **subscribe, call,
obligation, and birth are not primitives.** They are patterns of appending and
following. A subscription is just an appended fact that says "kernel, please
follow this log on my behalf and deliver batches." A mount is an appended quoted
expression. This is the sense in which "the events ARE the API" (§1.1) is
literally true — the fancy verbs are conveniences that compile down to appends
and folds.

### A tiny example

Message an agent and wait for its reply — the request/response you use a
thousand times a day, built from nothing but the two verbs:

```ts
const { offset } = await append("/agents/researcher", [
  { type: "agents/message-received", payload: { text: "summarize today's PRs" } },
]);
// follow-until: read forward from `offset`, resolving when the agent's answer lands
const answer = await follow("/agents/researcher", {
  after: offset,
  until: (e) => e.type === "agents/output-added",
});
```

If the agent's path never existed, the first `append` **creates** it — the log
materializes on first touch, and the event's *type* (`agents/message-received`)
tells the kernel which followers to arm (§6.5). No "create agent" call. Birth is
the first write.

### The Last RPC, concretely

The purist claim's sharpest edge (§7.1): **a method call and a durable workflow
are the same mechanism with the retention flag flipped.** Watch a call get
compiled to appends. `itx.integrations.slack.chat.postMessage({ channel })`
becomes:

```ts
// capnweb stops being a transport and becomes a COMPILER for this:
const { offset } = await append(scopePath, [
  { type: "invocation-requested",
    payload: { expression: ["integrations","slack","chat","postMessage"], args: [{channel}] },
    ephemeral: true },                                     // ← doesn't stay: this is what "RPC" means
]);
const result = await follow(scopePath, {
  after: offset,
  until: (e) => e.type === "invocation-completed",
});
```

That is a socket-latency request/response, because an ephemeral append with a
live-tail follower *is* request/response — same wire behavior, because that is
literally what it is (the ephemeral lane already exists, core-processor-contract
v14). Now flip **one flag** — drop `ephemeral: true` — and the identical call
becomes a durable, replayable, audited workflow step with provenance for free.
There is no second mechanism for "calls" and "workflows." Retention is the only
difference. That is why the whole of `rpc-targets.ts` is, in this framing,
sugar: capnweb is a compiler from `itx.foo.bar(x)` to `append` + `follow`, not a
parallel world beside the log.

---

## 5. How it differs from today, biggest first

Concrete deltas, ordered by how much felt weight and how many lines each
removes. Each is a specific §5 collapse or Appendix A finding — this is not
aspiration, it is descriptive of the codebase's own best 60%.

1. **The two fold engines collapse to one** (§5.3). Today the stream DO
   hand-rolls a second reducer — a ~290-line switch over 15 `stream/*` events,
   its own checkpoint debounce, its own `waitForEvent` vs the engine's
   `waitUntilEvent`, its own alarm multiplexer — *beside* the `StreamProcessor`
   engine every other domain uses. Host the core processor on the one engine.
   **Result:** one checkpoint store, one replay path, one wait primitive. The
   log's central concept stops contradicting the slogan printed on it.

2. **The four delivery lanes collapse to one** (§5.5). "Durable at-least-once
   delivery to a checkpointing follower" is implemented as three server modes
   (wake/push/webhook — webhook is push with batch size 1) *plus* a fourth,
   entirely separate client lane: the browser re-implements the connection
   ceremony the server host explicitly deleted — epochs, supersede fencing, dial
   deadlines, liveness probes (`stream-browser-store.ts`, 1,719 lines). Give the
   browser the *same* stream-owned, server-paced follow. **Result:** ~1,000
   lines of transport necromancy gone, and the two-liveness-systems bug class
   (#1894) with it. Wake's warm sink becomes a transport optimization, not a
   contract mode.

3. **`rpc-targets.ts` dissolves into appends and folds** (Appendix A §1, §5.1).
   6,014 lines of hand-written dispatch — and 5,270 lines of generated artifacts
   projecting it — exist because built-ins are a *second dispatch regime*
   resolved before the capability-table walk. But a mount is a fold of
   `capability-provided`; a `list()` is a fold read; `provideCapability`,
   `agents.message`, `scheduler.set`, `secrets.update`, `repos.create`,
   `sandboxes.create` are all **appends wearing method names**. Register
   built-ins as ordinary mounts resolved by the one longest-prefix walk.
   **Result:** −2,500 to −3,500 in `rpc-targets.ts`, the generated contract
   shrinks proportionally, the 11 near-identical collection classes and the blip
   table go.

4. **Four durability machines collapse to one obligation primitive** (§5.4). "A
   durable async job journaled on a stream: intent → started → exactly-one
   terminal → reconciler" is re-implemented per domain (agent LLM requests,
   script runs, scheduler triggers, repo creation, telegram sends) *and* the
   platform runs two more generic durability machines for the same eviction
   problem (the spine's backoff/park, the keepalive revival alarm). One
   `Obligation` on the engine — `{intentEventType, terminalEventTypes,
   expiresAt, run()}` — owns journaling, at-head reconciliation, idempotency,
   expiry, crash recovery. **Result:** ~350 lines gone from the agent loop
   alone, and the recurring "obligation without a reconciler" incident class is
   closed by construction.

5. **The vendor integrations stop being platform code** (§5.2). The core arrow
   (external event → log → agent) is implemented **four times** — Slack,
   Telegram, email, GitHub PR — each a router + transcriber, ~8.3k lines, all
   emitting the identical `agents/message-received`; the files literally confess
   ("shaped after the Slack webhook router"). All four are one parameterized
   follow-and-append. **Result:** ~2,500 platform lines delete; vendor SDK
   branches become userspace mounts the commit→rebuild loop can improve.

6. **Three "where code lives" collapse to two** (§5.6). Repo DO (clones per
   write), WorkspaceCore (COW overlays), and container sandboxes answer one
   question three ways, repo and workspace dialing each other *circularly*. Git
   is itself an append-only log; let the Repo DO hold materialized HEAD.
   **Result:** repo (truth) and sandbox (a computer), two substrates not three.

The through-line of every delta: the perimeter rots precisely because it is *the
part that isn't the log yet*. The architecture review found "engine clean,
perimeter rotting" and this framing explains why — the engine is streams, and
the perimeter is everything that reinvented streams badly.

---

## 6. Where this framing is wrong

I am the maximalist. I believe the log really is the substance. But a maximalism
that can't say where it breaks is a religion, so here is where "everything is a
stream event" hits reality — and then why it beats the two sibling framings
anyway.

### 6.1 The guarantee-classes objection (the strongest one)

Codex put the knife in exactly the right place (Appendix D §C1). "Everything is
a stream event" is powerful, but a journal row that is an immutable business
fact is **not operationally the same thing** as: a transient LLM token, an HTTP
request awaiting a response, a mutable blob pointer, a live WebSocket, or a
supervised external obligation. Each of those needs *different* semantics —
different retention, different delivery, different failure behavior. The moment
you admit that, "everything is an event" grows **guarantee classes**: a flag
here, a type-string convention there, a special processor rule, an invisible
retention policy. The root interface stays small while the *protocol* becomes
enormous. Codex's prior-art warnings are precise and correct: Kubernetes'
"everything is desired state plus a controller" produced CRDs, finalizers,
admission webhooks, status conditions, owner references — and Unix's "everything
is a file" survived only because it grew sockets, `ioctl`, `/proc`, and `mmap`.
**The abstraction won; literal uniformity did not.**

I concede the fact and reject the framing of it as a betrayal. Here is my honest
position, and I think it is the strong one:

**The log is the one source of TRUTH. Reads, blobs, transport, and effects are
VIEWS and DEVICES with their own rules — and that is not an exception to the
idea, it is exactly the Unix pattern that let "everything is a file" win.**

Look at what actually happened to Unix. "Everything is a file" never meant
"everything is a *regular* file with identical semantics." It meant everything
shares **one namespace and two verbs** (`open`/`read`/`write`), and the *devices*
behind those verbs have their own rules. `/proc` is a *view* — kernel state
projected as files. A socket is a *device* — a live channel wearing the file
interface. A named pipe retains nothing. `ioctl` is the escape hatch. Unix did
not fail because it had these; it *won* because it had them under one namespace.
Uniformity of *interface* with diversity of *device* is the winning pattern, not
the losing one.

iterate is already exactly here, and the code already named the categories. The
log is the regular file: durable, retained, the truth. The **ephemeral event is
the named pipe** — offset-ordered so it shares the log's interface, but retained
by nobody, evictable, for transients whose durable truth lands separately
(`schemas.ts:58-73` — that comment *is* FIFO semantics written out). **Blobs are
the block device** — out of the log because a 1MB delivery frame is physics, but
their *pointer* should be a fact (Appendix A member 10). **Egress is the
character device you write bytes to** — HTTP stays HTTP; a request is a question,
not a fact (Appendix A §4). **The external obligation is a supervised device** —
the log holds the intent and the receipt; the vendor call happens outside.

So codex's "salvage" and my thesis are one sentence from two angles. His wall
diagram — *"Everything durable becomes fact in a named journal. Live transport,
reads, blobs, and external obligations retain distinct semantics"* — is not a
retreat from "one log and a fold." It states *what the fold is the truth OF*: one
namespace, two verbs, a small set of devices behind them. The maximalist claim
was never "there is only one guarantee class." It was "there is only one source
of truth; everything else is a view or a device hanging off it." That survives
§C1 intact. What dies is the naive version that thinks a voice frame and a signed
contract deserve the same retention because they share the word "event." No
serious event-sourcing system believed that — Kafka has compacted topics,
tombstones, and retention windows for exactly this reason.

The discipline this demands, and that I accept: **the guarantee classes must be
few, named, and orthogonal** — retention (durable / ephemeral), locus (in-log /
device), and delivery (followed / point-read). Three axes, printed on the wall,
not thirty conventions discovered by grep. That is the difference between Unix's
handful of device types and Kubernetes' CRD sprawl. Keep the classes countable
and the maximalism holds. Let them multiply into type-string folklore and codex
is right that the protocol eats the model.

### 6.2 The real-time PCM audio problem (where the device lane earns its keep)

The sharpest concrete stress test, hoisted as a hard requirement (§6.14): the
loop must carry real-time voice — roughly **50 PCM frames per second per
direction**. A log is a *terrible* place for that. "Each event is a durable,
offset-assigned, reducible, replayable fact" is a beautiful sentence and a
catastrophic way to move 100 tiny audio buffers a second: write-amplify the
fold, retain the frames forever, deliver them through the at-least-once spine,
and you have built the world's most durable telephone and it stutters.

This is the proof that the ephemeral/device lane is **load-bearing, not a wart.**
The rescue is the FIFO insight above: raw PCM rides the ephemeral lane (a
character device, not a stored file); the *decisions and transcript* land as
durable facts. You trace what was *decided*, not 50 frames/sec of it. Pure log
maximalism with no ephemeral lane cannot do voice, full stop — and that this
codebase shipped the ephemeral flag *before* it shipped voice tells you the
device lane was structurally necessary, discovered under pressure, exactly as
Unix discovered sockets. Concede it loudly: **the log is where truth lives; it
is not where fast transient bytes flow.**

### 6.3 Why this beats "intelligent entity runtime"

The sibling essay's hero noun is "an intelligent entity runtime — a durable
outer event loop wrapped around a language runtime, where deterministic folds
and stochastic AI steps take turns." Every word is *true*, and it is **poetry
that hides the data model.** "Outer event loop" tells a newcomer nothing about
what to type; "intelligent entity" is a sales frame, not an interface. Ask the
runtime framing the operational questions — *how do I change state? read it?
survive a crash? make two hosts agree?* — and every answer is *"the log."* State
changes by appending; you read it by folding; it survives because it's a fold of
durable facts; two hosts agree because they fold the same log. The runtime
framing is a *consequence* of the data model dressed as a cause — right for the
marketing site, wrong for the wall above an engineer's desk, because it names the
*feeling* (a durable creature that thinks) instead of the *mechanism* (append,
fold, follow). And it smuggles the one genuinely hard thing — "the stochastic
step's output must be written down or replay lies" — in as a clause, when it is
the invariant the whole edifice balances on (§2.4). The log framing puts that at
the center where it belongs. Poetry is for selling; the manual is one log and a
fold.

### 6.4 Why this beats "operating system / three rings"

The other sibling's hero is governance: a **kernel** of non-extensible
machinery, an **iterate standard library** of deep first-party domains, and a
ring of **packages** — "apps/os becomes an OS in the literal sense." This is a
good *org chart* and a bad *explanation*, and it makes one error: **it
over-weights the tiny kernel.** By the document's own kernel razor (§6.12), the
irreducibly-kernel seed is small and boring — "run confined code, give it durable
storage, control the one exit" — and *streams are not in it*; they are
expressible in userspace. So three-rings spends its central noun ("kernel") on a
security wall that is small, load-bearing, and **not the point**, while the
actual substance — the log and the fold, which the razor places *outside* the
kernel as "the first library" — gets demoted to Ring 2 furniture. It is
governance cosplay: it draws crisp lines about *who may ship what* (a real fleet
question) and answers *nothing* about what the system *is*. Learn "kernel /
stdlib / packages" and you know the political structure but still can't say that
state is a fold of a log. Worse, it invites you to argue ring membership — *is
the agent domain Ring 2 or a package?* — a debate with zero bearing on the truth
that an agent is a reducer wearing a prompt. The rings are the *deployment*
answer; the log is the *model* answer. Put the model on the wall; keep the rings
in the ops runbook.

---

## The one line, for the wall

> **There is one write and one read. You append events to a log, and you follow
> the log. Everything else — state, screens, replies, an agent's memory — is a
> fold of that log, recomputed on demand: a database turned inside out.**

And the honest coda, so the maximalism survives contact with voice frames and
blob pointers: **the log is the one source of truth; reads, blobs, transport,
and effects are views and devices hanging off it, each with a few named rules.**
That is not a betrayal of "everything is a log." It is the reason "everything is
a file" won — one namespace, two verbs, and `/proc` and sockets behind them.
Nothing is faster than light, not even gravity; and nothing in this system is
true until it is a fact in the log.
