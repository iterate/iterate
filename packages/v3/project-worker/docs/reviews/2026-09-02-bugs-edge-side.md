# Bug hunt — the edge and the rpc-stub machinery (2026-09-02)

Area: `src/iterate-context.ts`, `src/session.ts`, `src/worker.ts`, `src/itx-entrypoint.ts`,
`src/context/rpc-stub-{directory,relay}.ts`, `src/fetch/rpc-stub-fetch.ts`,
`src/context/{dotted-path-proxy,invoke-handle}.ts`, the DO's `onPresence` /
`#unsetWhatNamesRpcStub`, `src/client/*`. Branch `wip/kernel-wayfinder-2026-07-30`, nothing under
`src/` was edited.

## Summary

Six confirmed defects, all clustered in ONE seam: **who recalls a lend, and who un-sets a rule.**
Five of them are the edge verbs (`provide` / `subscribe`) forgetting the `SessionTeardown` entry on
a path other than `null`, or undoing a rule they no longer own; the sixth is the pager swap in the
DO failing a page that its own replacement could have answered. The sixth-and-last is in the shipped
browser client, where a delta delivered during a gap heal is dropped and never re-triggers. Nothing
found here needs a malicious client — every proof is an ordinary sequence of the public verbs.
Three of the five edge bugs make `itx.rpcStubs.list()` (PRESENCE — "the physical truth") report a
stub that nothing names, for the session's whole life.

## Confirmed bugs, by severity

### 1. An expression rule's undo un-sets a LIVE provider's rule at the same match (HIGH)

**Where** `src/iterate-context.ts:205-210` (the expression branch of `provide`), vs the deliberate
non-undo at `src/iterate-context.ts:225-237` (the live branch).

**Mechanism** `provide(match, expression)` returns a `RewriteRuleHandle` whose undo is an
unconditional `#appendInBackground(rewriteRuleConfiguredEvent(match, null))`. The live-stub branch is
deliberately NOT written that way — its comment says the un-set is left to the DO's last-pager-close
"so a late-dying old session cannot clobber the new one's rule". The expression branch has no such
protection. So: session A configures a pure-data rule at `itx.m`; session B then takes the match over
with a live stub (the map holds one rule per match, so B's `itx.m ⇒ itx.rpcStubs.get('itx.m')`
replaces A's); when A's handle is disposed — or A's socket simply closes, since capnweb disposes
every exported handle at session end — A deletes B's rule. B is never told: its stub stays lent and
`itx.rpcStubs.list()` still reports `itx.m`, while every call on `itx.m` is `NO_ITX_EXPRESSION_MATCH`.
The DO's own protection cannot fire, because no pager closed.

**Proof** `e2e/review-bugs-edge-side.e2e.test.ts` → "provide: an expression rule's undo un-sets a LIVE
provider's rule configured later at the same match". Red at
`expect(await rpcStubRewriteRuleMatches(observer)).toContain("itx.m")` — and note the assertion just
above it PASSES: presence still lists the orphaned stub.

**Suggested fix** Make the expression branch's undo conditional the same way the live branch is:
either compare against the current rule before appending `null` (only un-set a rule whose target is
still the one this handle wrote), or carry the configured-at offset on the handle and make the
un-set a compare-and-set on it.

**Blast radius** Any deployment where one match is re-provided across sessions — the reconnect story
itself, and every "hand-configured rule, then a live provider takes it over" flow
(`rpc-stubs-lend-recall-and-offline.e2e` already spells that pairing as supported).

---

### 2. A `subscribe` the DO refuses still leaves the client's callback lent (MEDIUM-HIGH)

**Where** `src/iterate-context.ts:260-276`. Compare `provide`'s guard at
`src/iterate-context.ts:229-236`.

**Mechanism** `subscribe` lends first (`lendRpcStubOverPager` + `sessionTeardown.add`) and appends
second, with **no try/catch around the append**. `provide` has exactly that guard, added for exactly
this reason ("The DO refused the rule (STREAM_PAUSED): recall the lend, or a stub nothing names would
linger for the session"); its twin one layer up never got it. A paused stream is a normal operational
state here — the shipped `BreakerProcessor` fixture pauses it — so the refusal is not exotic. After a
refused `subscribe`, the pager stays open and `itx.rpcStubs.list()` reports `subscription:<name>`
until the session dies.

**Proof** `e2e/review-bugs-edge-side.e2e.test.ts` → "subscribe: an append the DO refuses (paused
stream) leaves the callback lent". The control half — the same refusal through `provide` — passes and
leaves presence empty; the `subscribe` half is red with `[ 'subscription:leaky' ]`.

**Suggested fix** Wrap `subscribe`'s `#append` in the same try/catch `provide` uses:
`catch (e) { this.#sessionTeardown.dispose(sessionTeardownKey); throw e; }`.

**Blast radius** Every refused `subscribe` (paused stream, a name the reduce rejects, a target the
codec refuses). Leaks a pager socket + a session-held capnweb dup per attempt, and PRESENCE lies.

---

### 3. A pager reconnect kills a page in flight instead of answering it (MEDIUM)

**Where** `src/context/rpc-stub-directory.ts:210-212` (the replace loop in
`acceptRpcStubPagerWebSocket`) → `:232-242` (`dropRpcStubPager`) → `:334-349`
(`#returnRpcStubAndFailItsPage`).

**Mechanism** One-pager-per-key is enforced when a pager becomes visible: the new pager drops every
other pager for the key with `dropRpcStubPager(old, "replaced")`. But `dropRpcStubPager` ends in
`#returnRpcStubAndFailItsPage`, which rejects `#rpcStubPagesInFlight[key]` with `RPC_STUB_OFFLINE`.
The page is keyed per **key**, not per socket, so the swap that exists to keep the key working is
what kills the caller waiting on it — even though the replacement pager is attached and lends
immediately. `rpcStubPagerClosed` is careful about precisely this distinction (`:226` — "another
pager for this key is open … return"); the replace path is not.

**Proof** `__workers-tests__/review-bugs-edge-side.test.ts` → "a pager reconnect while a page is in
flight kills the page (RPC_STUB_OFFLINE) instead of letting the new pager answer it". The call
rejects `RPC_STUB_OFFLINE` while a `LentAnswer` sits under the key.

**Suggested fix** Split the two things `dropRpcStubPager` does: closing/forgetting a SOCKET, and
declaring a KEY offline. On a "replaced" drop, return the stale borrowed stub but leave the page
pending (and re-send `{type:"page"}` down the new pager) — the page's own 10 s timeout stays the
backstop.

**Blast radius** Exactly the reconnect path the design leans on ("a provider dropping is EXPECTED;
the platform's answer is RECONNECT"). A delivery or a request/response call that happens to be
paging during the swap becomes a hard `RPC_STUB_OFFLINE` instead of a served call.

---

### 4. Replacing a live target with an EXPRESSION target never recalls the lend (MEDIUM)

**Where** `src/iterate-context.ts:200-204` and `:205-210` (`provide`), `:277` and `:279-285`
(`subscribe`).

**Mechanism** Both verbs recall the incumbent lend only on the `null` branch. The expression branch
of each returns without ever touching `#sessionTeardown`, so `provide(match, stub)` followed by
`provide(match, expression)` — or `subscribe({name, target: fn})` followed by
`subscribe({name, target: expression})` — leaves the first target's pager open for the session's
life. The DO cannot clean up after it either: its last-pager-close un-set only fires when a pager
CLOSES, and nothing closed this one. `itx.rpcStubs.list()` keeps reporting a key that no rule and no
row names.

**Proof** `e2e/review-bugs-edge-side.e2e.test.ts` → "provide/subscribe: replacing a live target with
an EXPRESSION target leaves the lend open". Red on the `provide` half (`[ 'itx.p' ]`); the
`subscribe` half below it is red the same way.

**Suggested fix** One line in each verb: `this.#sessionTeardown.dispose(sessionTeardownKey)` before
returning from the expression branch — the key stops being lent the moment it stops meaning the stub.
(In `provide` it belongs right before the `#append`, so a refused append leaves nothing behind
either.)

**Blast radius** Anyone who re-points a match/name from a live target to a pure-data one — the
documented "swap a live device for a stub/replay" move. Leaks a socket + a stub per swap and makes
PRESENCE unusable as the physical truth.

---

### 5. `subscribe`'s handle is a no-op for the ARRAY spelling of an `rpcStubs` target (MEDIUM)

**Where** `src/iterate-context.ts:278`
(`const targetIsLentRpcStub = Array.isArray(target) && target[1] === "rpcStubs";`).

**Mechanism** That predicate is meant to say "we lent this callback under `subscription:<name>`, so
the DO un-sets the row when the pager closes". It is also true for a caller-supplied EXPRESSION that
merely NAMES the registry — `subscribe({ target: ["itx","rpcStubs",["get","cam"]] })`, i.e.
subscribing an already-provided stub. Nothing was lent under `subscription:<name>`, so the handle's
`sessionTeardown.dispose(key)` finds no entry and does nothing, and the `target: null` append the
expression branch would have made is skipped: **the row can never be removed by disposing its
handle**, nor by the session ending. The STRING half of the identical target
(`"itx.rpcStubs.get('cam')"`) is not an array and behaves correctly — two codec halves, two
behaviours, where `expression.ts` promises "either works wherever one works, at every door that
dispatches".

**Proof** `e2e/review-bugs-edge-side.e2e.test.ts` → "subscribe: disposing the handle of a row whose
target is the ARRAY spelling of itx.rpcStubs.get(...) removes nothing". The string-spelled control
passes; the array-spelled row survives dispose.

**Suggested fix** Do not infer from the target's shape — record the fact. Set a local
`const lentHere = <the lend happened>` boolean where the lend is performed (`:260-269`) and branch
the handle's undo on that.

**Blast radius** Any client that hands `subscribe` a structured expression (the parsed half is the
form every internal caller uses) naming `itx.rpcStubs`. The row outlives its session and keeps being
delivered to; `itx.subscriptions.list()` accumulates.

---

### 6. Live state: a delta delivered during a gap heal is dropped and never re-triggers (MEDIUM)

**Where** `src/client/live-state-client.ts:53-69` (`reseed`, single-flight) with
`src/client/live-state-store.ts:58-73` (`apply` → `resync()`).

**Mechanism** `reseed` is single-flight (`if (healing || disposed) return`) and a dropped delta
leaves **no record** — `store.apply` calls `resync()` and returns. The heal's door read can
legitimately have been SERVED BEFORE that delta was produced (the door read and the subscription
delivery are independent channels), so the seed it lands is OLDER than the frame that was dropped.
Nothing re-triggers: the comment's "retried by the next delivered delta" only holds if the producer
happens to emit another one. A quiet producer leaves the store permanently stale, with no error and
no `onResync` signal.

**Proof** `src/review-bugs-edge-side.test.ts` → "live-state: a delta delivered during a gap heal is
dropped and never re-triggers". Sequence: seed at rev 5 → delta `{from:7,to:8}` (gap → heal) → delta
`{from:8,to:9}` arrives while healing (dropped) → heal answers rev 8 → no third door read, store
stuck at rev 8 with `{n:8}` while the producer holds `{n:9}`.

**Suggested fix** Remember that a heal was wanted while one was running (a `healWantedAgain` flag, or
the highest `to` seen) and re-run `reseed` once the in-flight one settles below that revision.

**Blast radius** The shipped browser client and the React hook over it (`client/react.tsx`,
`/demo`). Silent, permanent staleness on any producer whose deltas overlap a heal — most likely
exactly when the producer is busiest.

## Suspected, not reproduced

- **The idle quiesce returns a borrowed stub mid-call.** `returnBorrowedRpcStubs()`
  (`rpc-stub-directory.ts:173-178`) disposes every borrowed stub unconditionally, and the alarm's
  quiesce gate (`iterate-context-durable-object.ts:374`) counts only `#facetWorkInFlight`. The
  directory tracks `inFlight` per borrowed stub (`:82`, `:141`, `:162`) and **never reads it** — dead
  state that looks like the guard someone meant to write. Measured in the workers lane: with a call
  in flight on a lent stub, a forced `quiesce()` reports `{ borrowedRpcStubs: 0, dormant: true }` —
  i.e. `rpcStubTransportState()` claims the DO is hibernatable while a stub call is running. But the
  in-flight call still RESOLVED correctly after the dispose, so there is no observable failure to pin
  and I wrote no test. Worth a decision: either honour `inFlight` in the quiesce (as facets are
  honoured) or delete the field.
- **Non-Latin-1 args through the `/expression` lane / the terminal-fetch fork.** `worker.ts:77-78`
  copies `?itx=` straight into a header, and `iterate-context.ts:173-174` `JSON.stringify`s the
  expression into the same header — neither escapes to ASCII. Probed `/expression?itx=itx.nonexistent('日本')`
  against the real worker: it round-trips intact (404 with the argument verbatim in the message).
  workerd does not reject the value. No bug.
- **`SessionTeardown.disposeAll` is not fault-isolated** (`session.ts:43-46`: one throwing `dispose()`
  skips every later entry and leaves the map populated). Looked for a realistic thrower and found
  none: the relay's disposer wraps `close()` in try/catch, and capnweb's `Symbol.dispose` swaps in
  `DISPOSED_HOOK` so a double dispose is a no-op (verified in
  `@iterate-com/capnweb@0.12.2/dist/index.js:164-173`). Latent only.
- **The `SessionTeardown` composite key's premise is false but harmless.** `#sessionTeardownKey`
  (`iterate-context.ts:337-343`) says "a context name has no spaces" — `resolveContextPath` accepts
  any character but `/` in a segment, so `cd("/my path")` produces one. No collision is constructible
  though: a subscription name is `[A-Za-z0-9_-]+` (`core-processor.ts:39-41`) and a canonical
  itx-expression prefix's only spaces live inside quoted literals, which cannot split into a second
  valid `itx`-rooted prefix. Fix the comment, not the code.
- **Prototype-hop probes.** `then` / `toJSON` / `asymmetricMatch` / `dup` / `onRpcBroken` all return
  `undefined` through both the hop and the path proxy; `Class.prototype.foo` returns `undefined` via
  the receiver check. Found no hole.
- **Typos swallowed into `NO_ITX_EXPRESSION_MATCH`.** Only a typo'd ROOT degrades that way, and it is
  documented as an accepted quirk (`dotted-path-proxy.ts:135-139`). A typo'd METHOD under a real
  built-in root gives the crisp `NOT_A_METHOD` (`dispatch.ts:70-72`). Not a defect.
- **An EXPRESSION rule outliving its session.** Probed: it is correctly un-set when the client's
  socket closes (`#appendInBackground`'s `waitUntil` lands). No bug.
- **The terminal-fetch fork overwriting `x-itx-expression` on a caller's Request** — intended and
  documented (`itx-entrypoint.ts:36-45` exists precisely to route around it).

## Commands run

All from `packages/v3/project-worker`.

| Command                                                                                                                                       | Result                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm -s test` (baseline, before any new file)                                                                                                | `24 files / 252 tests passed`, exit 0                                                                           |
| `node build-sdk.mjs && npx vitest run --config e2e/vitest.config.ts e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts` (baseline)             | passed, exit 0                                                                                                  |
| `npx vitest run --config e2e/vitest.config.ts --silent=false --reporter=verbose e2e/<probe>.e2e.test.ts` (throwaway probes for A/K/D, X/Y/AA) | A, K, X, AA reproduced; D and Y did not — probes deleted                                                        |
| `npx vitest run --project workers __workers-tests__/<probe>.test.ts` (throwaway probes for B, C)                                              | B reproduced (`ERR RPC_STUB_OFFLINE`); C returned the stub mid-call but the call still resolved — probe deleted |
| `npx vitest run --project unit src/review-bugs-edge-side.test.ts`                                                                             | `1 expected fail`; with `test.fails` → `test`, fails at `expect(h.doorReads.length).toBeGreaterThan(2)`         |
| `npx vitest run --project workers __workers-tests__/review-bugs-edge-side.test.ts`                                                            | `1 expected fail`; the rejection is `RPC_STUB_OFFLINE`                                                          |
| `npx vitest run --config e2e/vitest.config.ts e2e/review-bugs-edge-side.e2e.test.ts`                                                          | `4 expected fail`; with `test.fails` → `test`, each fails at its intended assertion (lines 58, 94, 129, 153)    |
| `npx tsc --noEmit -p tsconfig.tests.json`                                                                                                     | clean                                                                                                           |
| `pnpm -s test` (after)                                                                                                                        | `26 files`, `252 passed                                                                                         | 2 expected fail`, exit 0 — the 2 are the new unit + workers proofs                                                   |
| `pnpm -s e2e` (after)                                                                                                                         | `37 files`, `141 passed                                                                                         | 6 expected fail`, exit 0 — the 4 new proofs plus the 2 pre-existing ones in `fetch-door-dynamic-live-ws.e2e.test.ts` |

Note: `pnpm test` / `pnpm e2e` run `node build-sdk.mjs` first, which rewrites
`src/generated/{demo-page,processor-sdk}.ts`. The resulting diff is cosmetic (the generator emits the
bundle on one line; the checked-in copy is prettier-wrapped) and is a pre-existing property of those
scripts, not an edit made by this review.

## Files added

- `src/review-bugs-edge-side.test.ts` — 1 `test.fails` (bug 6)
- `__workers-tests__/review-bugs-edge-side.test.ts` — 1 `test.fails` (bug 3)
- `e2e/review-bugs-edge-side.e2e.test.ts` — 4 `test.fails` (bugs 1, 2, 4, 5)
