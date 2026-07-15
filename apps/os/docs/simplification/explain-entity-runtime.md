# Iterate, explained: the intelligent entity runtime

> One of three parallel explanations. This one commits to a single framing:
> **an iterate project is an intelligent entity runtime.** The other two frame
> it as an operating system and as one big log. Both are true and both are
> wrong in ways this document ends by naming.

---

## 1. What it is, in one breath

**An iterate project is a durable outer event loop wrapped around an ordinary
programming-language runtime, in which deterministic folds and stochastic AI
steps take turns over one append-only history.**

Here is the same thing slower. Every program you have ever written has an event
loop — the thing that pulls the next message off a queue, runs your code, loops.
That loop lives inside one process, in memory; when the process dies, the loop
dies, and the program's whole idea of "where it was" dies with it. Iterate lifts
that loop *out* of the process and *into durable storage*. The loop is now a fold
of a log: to know where the program is, you replay its history. The process
underneath — a Cloudflare Worker, a script, an `async (itx) => {}` closure — is
just the inner interpreter the loop calls into; it can be evicted, redeployed, or
crash mid-thought, and the loop picks up exactly where it was, because "where it
was" was never in the process. And the loop's step is not always code. Sometimes
it is a plain reducer (deterministic: `state = reduce(events)`); sometimes it is
an LLM (stochastic). They coexist without breaking replay because the stochastic
step's answer is *written down as a fact* — replay reads the fact, it never
re-asks the model. That is the whole trick, and it is why you can build a thing
that thinks, survives, and replays bit-for-bit.

The slogan to carry, in Einstein's key — *nothing is faster than light, not
even gravity*:

> **Nothing outlives the process, not even the event loop — except here, where
> the loop is the thing that outlives the process.**

The hero of this story is not a kernel and not a database. It is a **runtime**:
a new kind, one whose loop lives in storage and survives its own body. Streams
are its heartbeat. Everything else is plumbing around the beat.

---

## 2. The 3-4 things you must know

Each is a slogan you could paint on a wall, then two or three sentences a
working programmer already has the words for.

### 2.1 There is one write: append. The only question is whether it stays.

> **Everything durable is an append; a call is just an append that doesn't
> stay.**

You never mutate anything. You add a fact to the end of a log at a path. If the
fact is meant to be remembered, it is a durable event and folds into state. If it
is meant to be forgotten — a request/response, a chunk of streamed text, a frame
of audio — you flag it `ephemeral` and it rides a transient lane that is never
folded (this lane exists: `src/domains/streams/schemas.ts`,
`core-processor-contract.ts`). Retention is the *only* axis. A method call and a
durable workflow are the same append with the flag flipped — which is why the
system can, in principle, delete its separate RPC machinery
(`src/rpc-targets.ts`, 6,014 lines) and have "call" mean "ephemeral append, wait
for the completion."

### 2.2 There is one read: follow. The only question is for how long.

> **A processor is a follower that never stops and remembers where it got to.**

Reading is following a log forward. Follow for a moment → `waitForEvent`. Follow
for a session → a subscription. Follow forever while remembering your place → a
**stream processor**. Follow from zero to now and stop → "state," a fold. There
is no separate database read, message consumer, workflow step, and audit query;
they are one verb at four durations. The engine is real and single:
`StreamProcessor` with `reduce` (pure fold), `processEvent` (side effects), and
`reconcile` (fix up unfinished work) — `src/domains/streams/stream-processor.ts`.

### 2.3 The LLM is a step whose answer you write down, so replay reads it instead of recomputing.

> **An LLM is a reducer whose result you must save, because you can't
> re-derive it.**

This is the one invariant that makes a stochastic step legal inside a
deterministic loop. The agent processor rebuilds a prompt by folding committed
history up to an offset, sends it to the model, and appends the answer as events
(`started` / `chunk` / `output` / `completed`) — the request id *is* the offset,
so the request carries no prompt body, just a reference (`apps/os/src/README.md`,
"Agents"; loop in `src/domains/agents/`). When the process is evicted and the
loop revives, replay finds the model's answer sitting in history *as a fact*, so
it is read, never re-asked. A fold over a history that contains non-deterministic
facts is still perfectly deterministic. Break this — recompute one model call on
replay — and the whole runtime stops being replayable. Never break it.

### 2.4 The only security is bytes leaving.

> **Internal fetch is free; external fetch is the entire security surface.**

An agent can run any code, message any internal entity, read any internal state
— none of it can hurt anyone until bytes try to leave the project. So the whole
security story collapses onto one door: the egress fetch, where secret
placeholders get substituted, allowlists are checked, humans can be asked, and
everything is audited (`itx.egress.fetch`, `src/rpc-targets.ts`; the doctrine is
Jonas's "the only real security is egress network bytes," ruminations §1.1 and
§6.11). Confinement stops being a thousand access checks scattered across the API
surface and becomes one gate on one verb. This is why the runtime does not have
to sandbox *behavior*, only *egress*.

---

## 3. The 5,000-LOC core, structured — the runtime loop at the center

Faithful to ruminations §6.9's kernel sketch, but told this framing's way: the
center is not "the journal" and not "a kernel." The center is **the loop** —
the thing that pulls the next event, decides whether the next step is a fold or
a model call, runs it, writes down what happened, and survives its own death.
Everything else is arranged in rings around that loop.

The budgets below are §6.9's "after collapse" targets, re-grouped so the loop is
the hero. They add up to ~5,700 — the honest number, not a rounded 5,000. (Today
the same pieces are ~14,400 src lines; the delta is the §5 collapses in section 5
below.)

```
runtime/
  loop.ts                 ~700   THE OUTER EVENT LOOP. Pull next event(s) →
                                 reduce (fold) OR dispatch a stochastic step →
                                 append what happened → checkpoint → repeat.
                                 Survives eviction by re-reading, not remembering.
  fold.ts                 ~400   reduce(state, event): the deterministic step.
                                 Pure. Same input → same output, forever.
  step-stochastic.ts      ~300   the model call as a step: build request by
                                 folding history to an offset, run it, WRITE THE
                                 ANSWER DOWN as events (offset = request id).
  obligation.ts           ~400   durable async work: a "-requested" event, a
                                 terminal event, an expiry, a reconcile() that
                                 starts/expires/crash-settles. ONE primitive
                                 (§5.4) absorbing keepalive + spine-park.
  contract.ts             ~300   the shape a processor must satisfy: state
                                 schema, owned event types, reduce/processEvent/
                                 reconcile, obligations (a "-requested" type
                                 cannot exist without its reconciler + expiry).

journal/
  append.ts               ~400   the ONE write. Stamp offset/path/source/at on
                                 commit; idempotency keys make retries inert;
                                 durable vs ephemeral is the retention flag.
  follow.ts               ~500   the ONE read at four durations: waitForEvent,
                                 subscribe, processor-forever, fold-to-now.
  store.ts                ~400   durable ordered storage bound to a confined
                                 name (DO SQLite today).

delivery/
  deliver.ts              ~800   at-least-once, stream-owned cursor, awaited
                                 delivery = ack, backoff → park. ONE lane —
                                 the browser follows the SAME lane (§5.5), so
                                 the 1,719-line browser transport dissolves.

capabilities/
  expression.ts           ~350   the universal quoted call: {path}, {call,args},
                                 {bind,props}. bind = a narrower capability
                                 (fewer things it can do). By-value JSON only;
                                 authority comes from the evaluating scope, never
                                 travels with the expression.
  resolve.ts              ~250   ONE longest-prefix walk over the mount table
                                 (itself a fold of capability-provided events).
                                 Built-ins are described mounts, not a 2nd regime.

boundary/
  authenticate.ts         ~350   credentials → a project-confined scope. The one
                                 door to authority; authority is never forged.
  confine.ts              ~350   which project, whose bytes. The invariant one
                                 project NEVER reaches another.
  fetch.ts                ~700   ONE fetch. Internal hostname → routes inside
                                 (free). External origin → the egress gate:
                                 secret substitution, allowlist, human-in-loop,
                                 audit. THE security surface.

source/
  repo.ts                 ~600   the config repo as durable HEAD + overlays:
                                 the entity's own source code, which it can read
                                 and rewrite.
  load-worker.ts          ~300   build + load the config worker from that source
                                 (userspace can't bootstrap itself).
```

Ring by ring: **the loop** (`runtime/`) is the whole point — the outer event
loop taking fold-steps and model-steps by turns, the obligation primitive
tracking work that outlives one turn and healing it after a crash, the contract
that makes it impossible to start durable work without declaring how it finishes.
**The heartbeat** (`journal/`) is the one write and the one read over confined
storage. **The nerves** (`delivery/`) carry a followed stream to whoever follows
it — server, browser, or a third-party coding agent — over one at-least-once,
stream-owned-cursor lane. **The reach** (`capabilities/`) is one
quoted-expression grammar and one resolution walk, no second dispatch regime.
**The skin** (`boundary/`) is one login, one confinement invariant, one fetch
whose external branch is the entire security surface. **The self-image**
(`source/`) is the entity's own code in a repo it can read and rewrite, plus the
loader that turns that code into the running config worker.

The slogan the file layout is built to support:

> **If a file doesn't help the loop pull, step, write, follow, or watch the
> exit, it isn't the runtime — it's a package.**

---

## 4. The API — four verbs, six types

The runtime's public face is tiny. Four verbs: **authenticate · append · follow
· fetch**. Six types. Everything a caller does — subscribe, call, mount, run an
agent — is one of the four verbs wearing a specific event type.

```ts
// ============ THE TYPES (all of them) ============

type Path = string;         // "/agents/researcher" — names an entity in a project
type EventType = string;    // "events.iterate.com/agents/message-received"
                            // a URI; its namespace names the owning contract (§6.5)

type Event = {
  type: EventType;
  payload: Json;
  idempotencyKey?: string;  // a retried append is inert
  ephemeral?: boolean;      // transient lane: never folded, never retained
  // stamped by the runtime on commit:
  offset?: number; path?: Path; source?: Provenance; at?: string;
};

type Expression =                       // the universal quoted call
  | { path: string[] }                  // itx.agents.get(p).processor  → quoted
  | { call: Expression; args: Json[] }  // …wake(x)                     → quoted call
  | { bind: Expression; props: Json };  // …postMessage.bind({channel}) → attenuated

type Contract<S> = {
  slug: string; version: string;
  state: Schema<S>;
  events: Record<EventType, Schema>;            // the event types it owns
  obligations?: Record<EventType, {             // a "-requested" type cannot exist
    terminal: EventType[]; expiresAfterMs: number; // without its reconciler + expiry
  }>;
};

type Processor<S> = {
  contract: Contract<S>;
  reduce(state: S, event: Event): S;                       // the deterministic step
  processEvent?(event: Event, ctx: Ctx<S>): Promise<void>; // side effects, keyed
  reconcile?(state: S, ctx: Ctx<S>): Promise<void>;        // heal unfinished work, at head
};

// ============ THE VERBS (all of them) ============

interface Runtime {
  // 1. log in — the only door to authority; returns a project-confined scope
  authenticate(credentials: Credentials): Scope;

  // 2-3. the loop's heartbeat: the only write, the only read
  append(path: Path, events: Event[]): Promise<{ offset: number }>;
  follow(path: Path, opts?: {
    after?: number;            // from where
    types?: EventType[];       // which facts
    fold?: string;             // contract slug → reduced state instead of raw rows
    duration?: "moment" | "session" | "forever"; // waitForEvent | subscribe | processor
  }): AsyncIterable<Event> | State;

  // 4. one door: internal fetch is free, external fetch is the security surface
  fetch(req: Request): Promise<Response>;
}
```

These map onto real code today: `authenticate` is the single method on the
unauthenticated entrypoint (`src/rpc-targets.ts`, `UnauthenticatedOs`); append +
follow are the stream's real verbs (`src/domains/streams/`); the egress branch
of fetch is `itx.egress.fetch`. Today they are wrapped in 33 root members
(ruminations §3); the framing says those 33 are sugar or packages over these
four.

### A processor, written in this API

A stateless processor that turns every inbound Slack message into an agent
message — a real reaction, in userspace, from the config worker:

```ts
const SlackToAgent: Processor<{}> = {
  contract: {
    slug: "slack-to-agent",
    version: "1",
    state: z.object({}),
    events: { "acme.example/slack/message": SlackMessageSchema },
  },
  reduce: (state) => state,           // stateless: nothing to remember
  processEvent: async (event, ctx) => {
    if (event.type !== "acme.example/slack/message") return;
    await ctx.append(`/agents/${event.payload.channel}`, [{
      type: "events.iterate.com/agents/message-received",
      payload: { text: event.payload.text },
      idempotencyKey: `slack:${event.payload.ts}`, // retried delivery is inert
    }]);
  },
};
```

You never wrote a host, a checkpoint store, a keepalive alarm, or a wake
handshake. Following-forever *is* the processor; the runtime owns the cursor.

### An agent turn, written in this API

An agent turn is not a special mechanism — it is `step-stochastic` folding
history and writing its answer down:

```ts
// inside the agent processor's reconcile(), at the head of the stream:
const request = foldHistoryToPrompt(state);           // deterministic build
const answer = await runModel(request);               // the ONE stochastic step
await ctx.append(agentPath, [{
  type: "events.iterate.com/agent/llm-request-completed",
  payload: { text: answer },
  idempotencyKey: `llm:${state.pendingRequestOffset}`, // the offset IS the request id
}]);
// replay reads this fact; it never re-asks the model.
```

### How subscribe · call · obligation · birth all fall out of the four verbs

None of these is a fifth verb. Each is a verb wearing a type:

- **subscribe** = `append("stream/subscription-configured", { target: Expression })`.
  You append a fact that says "follow this stream on my behalf, forever." The
  runtime folds it and starts following. (Real event today:
  `subscription-configured`, `src/domains/streams/`.)
- **mount** = `append("capability-provided", { at, expression, types, docs })`.
  A capability is a fact in the log; the mount table is a fold of these.
- **call** = `append(ephemeral "invocation-requested")` then
  `follow(duration: "moment")` until `invocation-completed`. Retention is the
  only thing that separates this from a durable workflow (ruminations §7.1).
- **obligation** = a durable `append` of a `-requested` event; the runtime
  follows until the terminal event or the expiry, and `reconcile` heals it if
  the process died mid-flight. (One primitive, §5.4.)
- **birth** = the *first* `append` to a never-touched path. The path always
  existed virtually; the first fact materializes it, and the event's *type*
  says which followers to arm (ruminations §6.2.3, §6.5). No creation ceremony,
  no birth RPC — just the first heartbeat.

The slogan the API is built to earn:

> **Four verbs and six types. If a file doesn't implement one of them, it's a
> package.**

---

## 5. How this differs from today's code

Today's `apps/os/src` is ~111k lines and *feels* heavy even though the runtime
needs ~4 concepts (§2-3). The framing predicts where the weight is: anywhere the
one loop, one write, one read, or one door got built more than once. Biggest
deltas, from §5:

**1. Two loops become one (§5.3).** The platform's central concept is
implemented twice: the generic `StreamProcessor` engine every domain uses, and a
hand-rolled twin *inside* the stream DO — a ~290-line reduce switch, its own
checkpoint debounce, its own wait primitive (`waitForEvent` vs the engine's
`waitUntilEvent`), its own alarm multiplexer
(`src/domains/streams/stream-durable-object.ts`, 1,307 lines). "Everything is
stream processing" is contradicted by the stream itself not using the processor
engine. **Collapse:** add a pre-commit validate hook and inline hosting to the
ONE engine; re-express the core as a hosted processor. One checkpoint, one
replay path, one wait primitive.

**2. One obligation primitive replaces five-plus (§5.4, the P0 fix).** "Durable
async job: intent → started → exactly-one terminal → reconcile" is re-written per
domain (agent LLM requests, script runs, scheduler triggers, repo creation,
telegram sends) *plus* two more generic durability machines (the spine's
backoff/park, the keepalive revival alarm —
`src/domains/streams/stream-processor-keepalive.ts`, 324 lines). This is the
biggest single source of felt weight in the agent loop, and the source of the
recurring "obligation without a reconciler" incident class. **Collapse:** one
`Obligation` on the engine. **~350 lines delete from the agent alone.**

**3. One delivery lane, and the browser follows it too (§5.5).** Delivery is
split into three server modes (wake/push/webhook) plus a fourth client-owned
lane: the browser re-implements the whole connection-reliability ceremony the
server host explicitly deleted — connection epochs, fencing, dial deadlines,
liveness probes, a 20k backlog valve
(`.../browser/stream-browser-store.ts`, 1,719 lines). **Collapse:** one durable
subscription; invert the browser to the same stream-owned, server-paced lane.
**~1,000 lines of transport necromancy delete**, plus a two-liveness-systems bug
class.

**4. One dispatch regime — built-ins become described mounts (§5.1).** Every
callable thing should be one concept, but built-ins are 54 hand-written classes
in `src/rpc-targets.ts` (6,014 lines) resolved *before* the capability-table
walk — a second dispatch regime dragging collision guards, four parallel
description corpora, and a 756-line generator plus ~5,270 lines of generated
artifacts (`src/itx-api.generated.ts`) whose only job is making hand-written
code agent-legible. **Collapse:** register built-ins as ordinary described
mounts resolved by the one walk. `rpc-targets.ts` shrinks toward the four nouns
its own header names; **the blip table, collision guards, most `__describe`
prose, and the bulk of the generator dissolve.**

**5. One channel mechanism, message-shaping in userspace (§5.2).** The core arrow
(external event → stream → agent) is implemented four separate times — Slack,
Telegram, email, GitHub PR — ~8.3k lines, each a router plus a converter that
reshapes a vendor message into an agent message, each file confessing it was
"shaped after" the last. All four emit the identical `agents/message-received`
envelope. **Collapse:** one parameterized Channel processor; move the reshaping
into the seeded `worker.ts` where the commit→rebuild loop can improve it.
**~2,500 platform lines delete.**

**6. Repo becomes the one filesystem; workspace and builder dissolve (§5.6).**
"Where project code lives" is answered three times — the repo DO (a full
`git.clone` into isolate memory *per write*), a 851-line COW workspace with a
234-line pure-delegation shim, and container sandboxes — with the repo and
workspace dialing each other *circularly*. **Collapse:** the repo DO holds the
materialized HEAD in its own durable storage; overlays become views; builds move
into the sandbox. **Two substrates, not three; no circular wiring, no
clone-per-write.**

Net, from §6.9's honest count: the kernel-shaped core drops from **~14,400 to
~6,000 src lines**, and the ~63k-line `domains/` folder becomes packages, sugar,
or deletion. The slogan the numbers support:

> **The runtime got heavy exactly where its one loop, one write, one read, and
> one door got built more than once.**

---

## 6. Where this framing is WRONG

Honesty first: attack this document's own framing before the rivals'.

### 6.1 Against "intelligent entity runtime"

The "runtime" framing oversells the loop and undersells the plumbing. **First,
the loop is a story, not a hot path.** There is no single `loop.ts` today and may
never be one — what runs is a swarm of Durable Objects each folding a stream,
woken by delivery, with no central pump. Calling that "an outer event loop" is a
narrative convenience; a reader who goes looking for the loop finds a delivery
lane and a checkpoint and feels lied to. **Second, "wrapped around a language
runtime" hides the hardest problem.** The genuinely un-userspace-able seed
(§6.12) is *run confined code, give it durable storage, control one exit* — the
load-bearing wall — and this framing waves at it as "the inner interpreter" when
it is the part you cannot get wrong. **Third, "intelligent" does rhetorical
work.** Strip the LLM out and the same runtime remains: durable folds over a log.
The intelligence is one step type, not the substance, and belongs in a package
(§6.8: an agent is a processor wearing a prompt). This is a true *sales* truth;
watch it doesn't become an architecture truth.

### 6.2 Against "operating system / three rings"

The OS framing (kernel + a standard library of deep first-party modules + leaf
packages, §6.8) is the safest, most fundable story, and it is wrong in one deep
way: **an OS does not take turns with a coin-flip.** Its whole promise is
*predictable* dispatch — the same syscall does the same thing. The single most
important fact about iterate is that the next step is sometimes a pure reducer
and sometimes a stochastic model call, and that the runtime is built *around
keeping replay honest across that boundary* (write the answer down; never
recompute). The OS framing files the LLM under "a module in ring 2" and loses
the plot, because the stochastic step is not a module — it is a *step type of the
loop itself*. It also imports kernel/userspace/rings/syscalls, a model the kernel
razor (§6.12) dissolves: streams, the thing the OS framing would call kernel, are
*userspace-expressible*, a library on the seed. An OS whose "kernel" turns out to
be a library is not an OS; it is a runtime with a small hard floor. Three rings
is a fine *governance* model and a bad *what-is-this* model — it explains the org
chart, not the loop.

### 6.3 Against "one big log / database"

The log framing (one substance — history — of which code, state, calls, minds,
and firms are all views, §7.7's through-line) is the most *elegant*, and it is
wrong the way elegance usually is: **it flattens time.** A database, even an
event-sourced one, is a thing you *query* — you stand outside it and ask about
the past. This framing has no verb for "and then keep going, forever, taking the
next step, sometimes by asking a model." It captures append and fold-to-now but
has no home for `reconcile` — the forward-living part, the healing of unfinished
work after a crash, the obligation still open. A log records what happened; a
runtime is still happening. The log framing also tempts Kafka-as-database
syndrome (§7.1's own failure mode): if everything is "just the log," chatty call
graphs become journal choreography, one slow fold on the hot path taxes every
call, and debugging a pipeline through offsets is its own hell. The log is the
*heartbeat*, and a heartbeat is not a body. Calling the whole system "a log" is
like calling a person "a pulse" — load-bearing, and not the thing that is
alive.

The one line to leave the reader with, in Einstein's key:

> **A database remembers what happened; this runtime is still happening — and
> that difference, like the difference between a recording and a heartbeat, is
> the whole thing.**
