# The simplification hunt — v2, in plain language

v2 after your 15 annotations. Rewritten to talk normally; your verdicts are folded in and
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

**"Should `itx.log` be `itx.stream`?" Yes — renamed.** Your own stream's door is
`itx.stream.append(...)` / `itx.stream.read(...)`; other contexts are
`itx.contexts.get('/path')`. (Singular "stream" = mine; "contexts" = everyone's, and each of
those is a whole context, not just a log.)

## 4. The four questions you "???"d, asked properly this time

**Q1 — picking a winner between two matching mounts (was: "specificity").** When a call
matches several mounts, we score each pattern and the highest score wins. Today the score is a
per-step list compared like version numbers — correct but nobody can predict it without
reading the matcher. The proposal: one number — _how many things did the pattern pin down_
(steps named + literal args matched) — ties broken by newest-wins, same as the shadow stack.
Every mount ever written in this repo picks the same winner either way. The one difference:
today a pattern with a literal arg (`itx.f('a')`) beats a longer pattern with a hole
(`itx.f(?x).g`) _always_; under the sum they tie and the newer one wins. **Question: is
"count what it pinned down, newest breaks ties" the rule you want, or keep the subtle
version-number compare?**

**Q2 — do we even want a generic call-anything door on the client?** cloudflare-os has no
equivalent of `invokeCapability("itx.a.b", args)` — a session hands you a small _typed_ object
(their version of `{stream, clients, facets}`), you call real methods on it, and chained calls
still cost one round trip because capnweb pipelines. Strings/expressions exist only where
config and agents live. For us that would mean: the TypeScript client SDK gets a typed
surface (autocomplete, type errors), and `invoke(expression)` remains for agents, config, and
dynamic callers. **Question: want a prototype of the typed client surface, or is
expressions-everywhere the identity of the product?**

**Q3 — the routing table is doing two different jobs.** Job one: agents and humans mounting,
shadowing, and revoking capabilities by pattern — the table with its shadow stack is _great_
at this. Job two: boring wiring — "this loaded worker should see SLACK and KV" — where
patterns, specificity, and shadowing buy nothing; a plain `{SLACK: …, KV: …}` map on that
worker's row would be simpler and more direct (that's how cloudflare-os wires everything).
**Question: keep using one table for both jobs (uniformity), or give loaded workers a plain
bindings map and reserve the table for the agent-facing namespace?**

**Q4 — who remembers where a live subscriber is up to?** For a browser/device connected over a
socket, today's design keeps a durable cursor row on the stream. cloudflare-os keeps NOTHING
for consumers that can re-ask: the client remembers its own position ("give me everything
after 75"), and a dead socket just dies — reconnect re-asks. Durable stream-side cursors exist
only for consumers that _can't_ re-ask (a webhook target can't call you back). We already
decided browsers hold their own cursor; this extends that to every live-socket subscription.
**Question: adopt "durable cursors only for targets that can't re-ask" as the rule?**

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
| workerd ships the capnweb #36 runtime pieces (future, free)  | −290         | the pager/stub polyfill deletes                            |

So the realistic landing zones: **~3,400 lines** with everything currently on the table,
**~3,150** if you also demote the string half to display/config, and **~2,900** the day
upstream ships Kenton's #36 plan — versus 3,976 today, while _gaining_ disable/rollback,
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
