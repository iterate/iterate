# The simplification hunt — v3

v3 after your second annotation round (10 notes). Rewritten to talk normally; your verdicts are folded in and
marked. (Background: 23 agents hunted, every finding was adversarially re-checked against the
code, ~40% died in verification.)

## 1. Bugs (status per your notes)

1. **Printing a stored mount can un-freeze frozen data.** If a mount's target contains
   `{$: {"?": 0}}` — meaning "this is literal data, do NOT treat it as a hole" — then printing
   it as a string produces `?0`, and parsing that string back produces a real hole. So
   print-then-parse turns protected data into caller-controlled input. The fix is deleting
   three lines (the printer stops unwrapping `$`), after which `{ $: ?0 }` round-trips exactly.
   _(Your note here was bigger than the bug — "make the whole codec simpler" — see §2.)_
2. **DONE-when-simpler (your condition, and it is simpler): the push-retry ladder.** Two bugs,
   one restructure. Today a "skip bad events" subscription halts after 3 skips _ever_ (the
   counter never resets on success), and a plain 5-minute outage of the target gets treated
   like a poison event — it burns a few retries, sacrifices two innocent events, and halts,
   while a "halt" subscription would have retried for hours. The restructure that fixes both is
   genuinely easier to reason about: **retry every failure with backoff up to the limit; only
   when retries are exhausted look at the policy** — "halt" stops the subscription, "skip"
   drops that one event (with an audit event) and moves on. One ladder, then one policy
   decision at the end. No interleaved counters.
3. **APPROVED + your addition: the fetch lane.** Writing `itx.web.fetch('/path')` in an
   expression silently throws away `'/path'` today (the real Request rides in separately, and
   the args just vanish). Fix is one loud error. Your addition — "make sure all the different
   shapes of fetch are supported" — turned into a checklist we verified: bare terminal
   `itx.site` on the fetch lane (works — normalized to `.fetch`), explicit `itx.site.fetch`
   (works), WebSocket upgrades through it (works, proven), fetch on a facet address (works),
   fetch on a stateful worker (works, native 101), and fetch with expression args (now a loud
   error instead of silent drop).
4. **Userspace processor code is re-fetched on every single commit.** The facet is warm and
   ignores the result, but we still resolve the source expression and re-hash all modules per
   event batch. **Your note: plan this carefully** — agreed; anything touching dynamic-worker
   warm paths has burned us before. Proposed careful shape: resolve modules once at
   enable-time, store them durably per slug; the hot path reads the stored hash only; source
   changes go through an explicit re-enable (which is also when the version-marker abort
   already runs). No behavior change on the warm path at all — it just stops doing wasted work.
5. **DROPPED per your note** (we don't support older workerd runtimes): the alarm-woken-DO
   name bug. We'll note the runtime floor (workerd ≥ 2026-07-02) in the build log and move on.
6. **APPROVED (your "ok"):** delete the dead `#running` field; stop collecting numeric holes
   the must-use check then ignores. Both done.
7. **APPROVED (your "fix this then"): the stalled-batch gap.** If the DO is evicted mid-batch
   and no new event ever arrives, delivery stalls until the next append — nothing resumes it.
   Fix (cloudflare-os's pattern): whenever any cursor is behind the head, make sure ONE alarm
   is armed; the alarm handler re-drives everything behind. We get the "is there unfinished
   work" marker for free (cursor < highest offset). Done.

## 2. Your new ask: make the codec itself smaller

You're right that it's the biggest single piece (641 lines — parser, printer, matcher,
substituter, evaluator). Nothing else is 200+ lines of load-bearing cleverness. Three concrete
directions, smallest first — they compose:

- **(a) Delete the third walker (~30 lines, no behavior change).** Three separate functions
  walk expression trees looking for holes, each with its own slightly-different detection code
  — that's how the last two codec bugs happened. `substitute` can just _report_ whether it
  consumed the caller's args while doing its normal work; the standalone checker dies.
- **(b) Make "rest" explicit (~20 lines + kills a bug class).** Today `...?` guesses where to
  start splicing by scanning the whole arg list for the highest-numbered hole — that guess has
  already shipped one bug. Writing `...?2` ("everything from arg 2") makes the author say what
  they mean, and bare `...?` stays legal in the common case (no numbered holes around it).
- **(c) The parser question — the real size win.** Half the file is a hand-rolled string
  parser/printer. The mine found capnweb's recording trick: instead of _parsing_
  `"itx.grok.chat({model:'grok-4', messages:?})"`, let authors write real code against a
  recording proxy — `expr((itx, hole) => itx.grok.chat({model: 'grok-4', messages: hole()}))`
  — and capture the expression from what the code _did_. Typed, autocompleted, no grammar. The
  string form then only needs _printing_ (for display/debug) plus parsing for config seeds and
  humans who prefer strings. We can't delete the parser while "the string half is first-class"
  stands (your earlier call) — but if authoring shifts to `expr()` + structured, the parser
  stops growing and could eventually shrink to the seed-file subset. **Decision for you:** keep
  the string half as the primary authoring surface, or demote it to display/config while
  `expr()` becomes how code authors expressions?

## 3. Answers to your direct questions

**"How can we carry the call on the pager socket — what about data types WebSocket frames
can't carry?"** Fair challenge, and it's the real cost of that proposal, so here's the honest
picture. Today the invoke path is: DO sends "wake" over the socket → relay calls back over
Workers RPC → DO gets a short-lived RPC leg → the call goes over that leg. The leg is real
Workers RPC, so it _could_ carry stubs, Requests, streams. But what actually crosses it today
is only expression data — JSON args in, JSON results out (events, snapshots, strings). The
proposal says: since it's JSON anyway, put `{callId, path, args}` frames on the socket and
skip the three-phase dance. If a provider one day wants to _return a capability_ from a call,
frames can't carry that — but note our doctrine already answers it: capabilities travel as
NAMES (you mount something and hand back its name), not as live return values. So the choice
is really: **(i)** keep the RPC leg and its handshake to preserve "results may someday be rich
types," or **(ii)** adopt frames and make "invocation payloads are plain data; capabilities
move by mounting" an explicit rule. I lean (ii) because it matches the names-not-authority
doctrine we already live by — but it does close a door, so it's yours to call.

**"Why fold the stateful runner into the Stream DO?" + your "home path" idea.** The narrow
reason: the runner DO duplicates ~80 lines of the stream's machinery (loader wiring, version
markers, the method-walk) and escapes the idle-quiesce sweep. But your instinct is the better
frame: apps/os "apps" are DO classes exported from config repos — and if **every app instance
has a home stream path**, then "the app IS a facet of its home stream" gives it an address
(`itx.contexts.get('/apps/crm')`), an event log it can append to, processors beside it, and
the stream's lifecycle (quiesce, migration, deletion) for free. The stateful runner then isn't
a special DO class at all — it's just "a facet whose class came from userspace code." One DO
class in the whole system. Proposed: adopt with the home-path framing.

**"wtf - talk normal" (the routing-breakage rule).** Plainly: if someone mounts a bad
capability — say a default route that swallows every call — you need working tools to see
what's mounted and remove it. If those repair tools themselves went through the routing table,
the bad mount could swallow _them_ too and you'd be locked out. So the handful of repair verbs
(revoke a mount, read the raw log, dump the table) talk straight to the DO and never route.
That's the whole rule.

**"Should `itx.log` be `itx.stream`?" Yes — and "stream" stays THE noun everywhere** (your
note on the recovery kit too: it reads "unrouted stream read", not "raw log").

**How to think about contexts and streams — the walkthrough you asked for.** The collapse says
there is ONE thing, and you can call it a stream: a stream = one DO at a path
(`prj_x` + `/agents/bob`) = its event log + its routing table + its processors + its connected
clients. "Context" was our second name for the same thing seen from the capability side; after
the collapse we don't need two nouns — _a stream HAS a table; there is nothing else for
"context" to mean._ The tree is just paths: `/` is the project root stream, `/agents/bob` and
`/clients/esp32-1` are other streams in the same project. Nothing is nested physically —
"child" is naming convention plus one routing row.

_Your agent example, walked end to end._ Agent bob lives at `/agents/bob`. His stream holds
his conversation events; his processors run as facets on it. He makes himself a capability:
his processor calls `provide({pattern: 'itx.scratch', target: …})` — that mount lives in
**bob's** table, invisible to everyone else (attenuation-by-context, as decided). Bob's table
also carries one seed: the default route `itx ⇒ itx.contexts.get('/')`. Now when bob's code
calls `itx.scratch.note('…')`, his own table answers. When he calls `itx.slack.send(…)`, his
table misses, the default route forwards the WHOLE call to the root stream, and the root's
`slack` mount answers. That's the entire fallback machinery: one seed row. The root never
sees `scratch`; bob never needed his own copy of `slack`.

_Your device/browser example._ Today the honest answer is: every client connects to the
project ROOT — `connect({path: '/clients/esp32-1', capabilities})` parks your live capability
at the root DO, and `path` is just your roster name there; there is no per-client DO. That's
the right default for browsers: presence + live capabilities, nothing durable, dies with the
socket. The collapse makes the richer option natural for devices that EARN durable state: the
ESP32 can connect _at_ `/clients/esp32-1` as a real stream of its own — its telemetry appends
to its own log, its processors run there, capabilities it provides mount into ITS table — and
its default-route seed falls through to the root exactly like bob's. Same one mechanism at
every level. The rule of thumb to write down: **a roster row when you only need presence and
live capabilities; your own stream when you need a log, processors, or mounts of your own** —
and connecting "to a path" should eventually mean parking at that path's stream (today it
always parks at the root; that's the one place the code hasn't caught up with the model yet,
and it's a small change to the edge's connect()).

## 4. The four questions you "???"d, asked properly this time

**Q1 — RESOLVED harder, per your note ("just matched prefix length… apps/os really just
matches an array of strings — we don't want to go much more complicated").** The new proposal,
bigger than the one-integer idea: **a pattern is a dotted path — an array of strings — plus at
most a terminal call that binds the caller's args.** Matching is element by element; the score
is the matched prefix length; ties go to the newest mount (the shadow stack you already have).
What this deletes: literal-arg patterns (`itx.f('a')` as a _pattern_ stops being a thing — if
you want per-argument behavior, that's a real function in the config worker, which was always
the escape hatch), the per-step specificity algebra, `compareSpecificity`, and most of the
matcher's argument walking. What survives: named captures in the terminal call
(`itx.agents.get(?name)` still binds `name`), boundary args (calling at the mount itself), and
frozen-arg TARGETS (`itx.grok ⇒ itx.openai.chat({model:'grok-4', messages:?})` — that
machinery is substitution, not matching, and is untouched). Estimated ~120–150 more codec
lines gone, and the matcher becomes explainable in one line: _longest matching path wins;
newest breaks ties._ **Confirm and I'll build it.**

**Q2 — do we even want a generic call-anything door on the client?** cloudflare-os has no
equivalent of `invokeCapability("itx.a.b", args)` — a session hands you a small _typed_ object
(their version of `{stream, clients, facets}`), you call real methods on it, and chained calls
still cost one round trip because capnweb pipelines. Strings/expressions exist only where
config and agents live. For us that would mean: the TypeScript client SDK gets a typed
surface (autocomplete, type errors), and `invoke(expression)` remains for agents, config, and
dynamic callers. **Your verdict: in principle yes.** Noted alongside your two riders: capnweb's validate
support exists now, and the real difference from cloudflare-os is that our capabilities are
DYNAMIC — apps/os answers that with self-describing capabilities (types on each capability),
which you deliberately didn't port because it's heavy but could exist. So: parked as a
prototype for after the current arc, shaped as "typed root for the static surface,
self-description as an optional layer for dynamic mounts".

**Q3 — the routing table is doing two different jobs.** Job one: agents and humans mounting,
shadowing, and revoking capabilities by pattern — the table with its shadow stack is _great_
at this. Job two: boring wiring — "this loaded worker should see SLACK and KV" — where
patterns, specificity, and shadowing buy nothing; a plain `{SLACK: …, KV: …}` map on that
worker's row would be simpler and more direct (that's how cloudflare-os wires everything).
**Your verdict: "everything is via one itx object plz." Closed** — no split; loaded-worker
wiring keeps going through the one itx/table like everything else.

**Q4 — who remembers where a live subscriber is up to?** For a browser/device connected over a
socket, today's design keeps a durable cursor row on the stream. cloudflare-os keeps NOTHING
for consumers that can re-ask: the client remembers its own position ("give me everything
after 75"), and a dead socket just dies — reconnect re-asks. Durable stream-side cursors exist
only for consumers that _can't_ re-ask (a webhook target can't call you back). We already
decided browsers hold their own cursor; this extends that to every live-socket subscription.
**Your verdict: yes. Adopted as the rule** — stream-side durable cursors exist only for
targets that can't re-ask (today: push rows — which is already true); any future live-socket
subscription is client-cursor + re-ask, no row.

## 5. Everything else the hunt found (unchanged from v1, condensed)

- **Platform features that delete our code:** workerd's `ctx.props` lets ONE loaded isolate
  serve every context (cacheKeys become deploy × content — the $7.8k lesson's endgame), and
  facets can now receive constructor props — which deletes the whole `configure()` first-
  contact handshake. `facets.delete` gives us the missing `disableProcessor`. `unsafe.evict`
  lets CI kill a DO on demand — every invariant we currently prove by _waiting_ becomes a fast
  test. `kv.list({prefix})` replaces our rewrite-the-whole-array row storage.
- **capnweb features we ignore:** one line makes `/api` accept plain HTTP one-shot calls (no
  WebSocket handshake for a CLI script); `Symbol.dispose`/`onRpcBroken` make dead clients
  clean up instantly (today the roster lies until a 10s timeout); the Upgrade-over-RPC fork
  feature WE commissioned is installed and unused (`/cap` could collapse into `/api`); its
  stream serialization is the right transport for voice firehoses; `serialize()` would stop
  `JSON.stringify` silently mangling Dates/bytes/Errors at the commit point.
- **Adopted concept answers (from v1, your open questions):** ITX and STREAM are ONE concept
  (rename shipped as `itx.stream` + `itx.contexts`); the four-tables question resolves to
  "claims vs progress — a progress register lives with the engine that advances it"; `roots`
  stops being an object (a plain record of host functions spread into config-seed scope — the
  naming debate disappears because there's nothing left to name); capnweb still terminates at
  the edge only (your ruling; the rule now stated as "session state is live JS — it lives in
  the CPU-billed tier"); subscriptions become event-sourced mounts at `itx.subscribers.<name>`
  with cursors keyed by mount identity (shadow a subscriber and its cursor freezes; revoke
  and it resumes where it stopped — wiretaps for free).

## 6. How much code all of this saves

Baseline, measured now: **3,976 product lines** (all of src/ excluding tests; an earlier "4.7k"
figure in chat was a counting mistake). Per-item, from the verifiers' own numbers — net (code
deleted minus code the replacement adds):

| change                                                       | net lines    | notes                                                      |
| ------------------------------------------------------------ | ------------ | ---------------------------------------------------------- |
| Bug fixes (§1, done)                                         | ~0           | fixes, not deletions                                       |
| Codec: merge the third hole-walker                           | −27          |                                                            |
| Codec: explicit `...?n` rest                                 | −20          |                                                            |
| Winner-picking as one number (Q1, if yes)                    | −25          |                                                            |
| `invokeCapability` off the wire + client classes client-side | −80          |                                                            |
| Transport: frames on the pager (§3, if yes)                  | −80          | deletes wake/activate/borrow ~120, adds frame dispatch ~40 |
| Transport: meta-on-upgrade + facade 5→3 verbs                | −55          |                                                            |
| `roots` flatten (adopted)                                    | −90          | the class + builder plumbing                               |
| `itx.stream`/`itx.contexts` rename (adopted)                 | −15          | mostly a rename                                            |
| Subscriptions-as-mounts (adopted)                            | −30          | deletes rows/verbs ~75, adds the inline projection ~45     |
| Stateful runner into the stream (§3, if yes)                 | −100         | the 149-line DO class folds into existing facet machinery  |
| `ctx.props` facets: delete `configure()`/identity handshake  | −60          |                                                            |
| cacheKey minted in one place + run/fetch merge + drop `type` | −48          |                                                            |
| `kv.list` per-name rows                                      | −20          |                                                            |
| NEW capability: `disableProcessor` + rollback                | +25          | an add — it's missing today                                |
| NEW capability: stalled-batch alarm (done)                   | +15          | an add — closes the gap                                    |
| Edge: HTTP one-shot `/api`, dispose/onRpcBroken, fetchCap    | +20          | small adds that delete behavior-bugs, not lines            |
| **Total, everything above adopted**                          | **≈ −590**   | **3,976 → ≈ 3,400**                                        |
| Codec parser demotion (§2c, your call)                       | −200 to −250 | parser+printer shrink to the seed/display subset           |
| ~~workerd ships #36, pager deletes~~ — CORRECTED, see below  | ~~−290~~ 0   | upstream shipped its version and it CANNOT cover our case  |

**Your question on the −290 — ANSWERED, and the premise inverted** (full report:
`research/pager-vs-upstream-36.md`). Kenton already shipped his version, June–July 2026:
`ctx.restore()` + persistent stub tokens (a stored stub is a token that REPLAYS its
restore-chain against a fresh instance of an addressable target on every use). And it
**deliberately cannot cover our case**: plain retained stubs — like a browser's live capnweb
capability — are rejected from storage, and a restore on a fresh relay isolate cannot summon a
browser socket. His own motivating example ("a list of subscriber callbacks") is, for
browser-origin callbacks, exactly what his mechanism can't express. So the pager is NOT a
polyfill waiting for upstream to delete it — it covers the half upstream explicitly rejects,
and our close-to-revoke semantics are _stronger_ than his irrevocable-stub stopgap (whose own
doc says it WILL be retracted once a grants table exists — which is what our mount table
already is). Where upstream DOES apply (re-derivable targets), confidence it slots into our
seam is HIGH and **zero seam changes are needed now** — the two properties that make adoption
cheap already hold (park meta is pure storable data; every consumer goes through the facade).
The one discipline to keep: presence only ever derives from sockets, never from stored rows.

**Does restore work for WorkerEntrypoints, not just DOs? Yes — natively.** `ctx.restore(params)`
exists on both `ExecutionContext` (stateless workers/entrypoints) and `DurableObjectState`, and
persistent stubs are minted via `ctx.exports` — which includes props-parameterized loopback
entrypoints. So a restorable stub can rebuild to a plain WorkerEntrypoint with no DO involved.
(One sharp edge: raw `env` service-binding stubs can NOT be stored — only stubs minted through
`ctx.exports` or your own `[restore]`. Storage always goes through a restore method you wrote.)

**Your KV-cached-capabilities future, mapped onto Kenton's shipped shape.** The goal you named
— itx capabilities cached in KV so stateless workers use them WITHOUT waking a DO — is
structurally exactly his design, and we're already holding the right pieces:

- Our mount rows are `{pattern, target-expression}` — pure JSON, trivially cacheable in KV.
  **An itx expression IS restore-params** (storable data that re-materializes a capability on a
  fresh instance); our resolver IS a `[restore]` method by another name.
- After the roots-flatten, the builtins record splits naturally into **DO-free roots**
  (bindings, workers/loader, kv, secrets, whoami) and **DO-resident roots** (stream, clients,
  facets, contexts). A stateless worker holding a KV copy of the table can fully serve any
  expression whose target stays DO-free; only genuinely actor-shaped targets wake the DO.
- The platform-native veneer, when we want it: give the edge entrypoint
  `[restore]({ctx, expr})` that resolves the expression **through the routed door** — then any
  itx capability becomes a real persistent stub Cloudflare's chain-checking understands, and
  routing through the table (not around it) preserves deletion-is-revocation even for stored
  stubs. That's strictly better than his own irrevocable stopgap, using his own machinery.
- The prefix-matcher simplification (§4 Q1) is also what makes stateless-side matching
  trivial: element-by-element string comparison over a KV-cached array needs no specificity
  algebra. One more reason to build it.

Not for now, per you — but nothing we ship in the current arc fights it, and three things
actively prepare it (expressions-as-JSON, the roots-flatten, the prefix matcher).

**Standing doctrine (your order, recorded): everything we build stays cleanly aligned with
Kenton's shipped direction.** Concretely: transport state placement per his #36 shape (edge
terminates capnweb; DO speaks Workers RPC; the pager covers the unaddressable half he
rejected); capability persistence per his restore shape (store re-derivation data, never raw
stubs; our expressions are the params); revocation per his stated endgame (an auditable grants
table — which our mount log already is; never adopt irrevocable semantics for anything
currently revocable); loading per ctx.props (authority per-call, one isolate per content).
Divergences require a written justification in BUILD-LOG.

So the realistic landing zones: **~3,400 lines** with everything currently on the table,
and **~3,150** if you also demote the string half to display/config — versus 3,976 today
(the earlier "another −290 when upstream ships #36" is withdrawn per the research above),
while _gaining_ disable/rollback,
one-shot HTTP clients, wiretap subscriptions, instant dead-client cleanup, and a deterministic
eviction test lane. For scale: apps/os's delivery file alone is 2,485 lines.

## 7. What I'll build once you annotate (proposed order)

1. Approved fixes: DONE this round (ladder restructure, fetch-lane guard, #running,
   must-use, stalled-batch alarm, print/$-escape).
2. The three adopted collapses: roots-flatten → `itx.stream`/`itx.contexts` rename →
   subscriptions-as-mounts.
3. Transport: your call on frames-vs-RPC-leg (question in §3).
4. Loaders: runner-into-stream with the home-path framing (§3), `ctx.props` spike, cacheKey
   mint, `disableProcessor`.
5. Edge adoption: HTTP one-shot `/api`, dispose/onRpcBroken, fetchCap, kv.list rows.
6. The `unsafe.evict` CI lane.
7. The codec direction (§2c) once you pick.

---

# STATUS AFTER THE BUILD SPRINT (increments 41–44, deploy `edge-1`)

**Built and live-proven** (nine proof suites ALL PASS; 87 unit tests):

| what                                                                                                                                                                             | increment    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Rich values everywhere — callback/Date/bytes across the FULL path; the one JSON boundary (stateless run fetch tunnel) replaced with a real RPC `run` method; frames idea dead    | 41 (rich-1)  |
| Loader unification — one wrapper/isolate per source, cacheKeys minted in `confinedWorker`, `type` discriminator dropped                                                          | 41           |
| THE MATCHER COLLAPSE — longest-prefix + newest-wins, one integer; single-binding-site rule; `spentArgs` from substitute (third walker dead); explicit `...?n`; table-based tests | 42 (codec-2) |
| Roots-flatten — the object deleted; plain host-scope record; provenance gate = key-set; `Object.hasOwn`                                                                          | 43 (vocab-1) |
| `itx.stream` (own, append/read only) + `itx.contexts` (ROUTED siblings — attenuation spellable); recovery-kit rule pinned                                                        | 43           |
| One-shot HTTP batch at `/api`; instant dead-client cleanup (`Symbol.dispose` + `onRpcBroken`); `fetchCap` (the fork feature, used); `disableProcessor`                           | 44 (edge-1)  |
| The smallest repo — `itx.repo.put` + `files.read` fallback: project-authored source runs as workers                                                                              | 44           |
| Earlier this arc: entrypoint interposition (39), persistent stubs in use + cross-deploy restore proof (40), ladder restructure + resurrection pass + print/$ fix (38)            | 38–40        |

**Still to build (next sessions, in order):**

1. **Subscriptions-as-mounts** — the adopted storage collapse (event-sourced rows at
   `itx.subscribers.<name>`, cursors keyed by providedAtOffset, freeze-and-fork wiretaps,
   parent projection folded inline in append, delivery by row identity). The one big decided
   piece not yet built — deliberately kept whole for a fresh session.
2. **Runner-into-stream with the home-path framing** — now that the repo seam exists, the
   design conversation you asked for can happen concretely (apps = repo-exported DO classes
   living as facets of a home stream).
3. Mechanical: TS-generated runner via build-sdk; `kv.list({prefix})` per-name rows; the
   `unsafe.evict` CI lane.

**Design questions still open for you:**

- The browser/navigate story (your annotation 8): apps/os browsers connect at
  `/clients/<id>` and the system calls `navigate` on them. In the current model that is: the
  browser connects with `capabilities: { navigate }`, parked at the root, callable as
  `itx.clients.at('/clients/<id>').call(['navigate'], [url])`. The open choice is whether a
  browser ever earns its OWN stream (the roster-row vs own-stream rule from §3) and where a
  system-wide "navigate someone" capability should be mounted.
- The codec's string half: table tests are in; fidelity-reduction beyond the matcher collapse
  is possible (drop mid-path captures? drop object spreads?) if you want to go further.
