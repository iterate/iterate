# Core test inventory and reduction evidence

This is an audit of `main` at `cfd8a1d3687c77755817d6c5ece586bc15a24bf6`.
It does not recommend deleting a test solely because it is long, difficult, or
exercises a Cloudflare runtime behaviour.

## Measurement

Run [`count-loc.sh`](count-loc.sh) from this checkout. It counts physical
lines, including blanks and comments, in tracked TypeScript and TSX files. It
does not pretend that a comment-aware count can reliably distinguish code from
types, declarations, and multiline expressions. The selectors are in the
script, so a changed boundary changes the result visibly.

The core runtime definition is deliberately narrow:

- `apps/os/src/context/`, excluding tests and test support;
- `apps/os/src/stream/`, excluding tests and test support;
- the eleven context shell files named in the script; and
- `packages/iterate/src/`, excluding tests and test support, as the public SDK.

The context engine and SDK are reported both separately and together. The SDK
number includes public app, session, OAuth, and React client modules; it is a
useful upper bound, not a claim that every SDK line belongs in the execution
kernel.

| Group                               |  Files | Physical lines |
| ----------------------------------- | -----: | -------------: |
| Context engine runtime              |     23 |         10,377 |
| Stream engine runtime               |      5 |          3,993 |
| Context shell runtime               |     11 |          4,417 |
| **OS context runtime**              | **39** |     **18,787** |
| SDK runtime                         |     22 |          6,758 |
| **Narrow core runtime**             | **61** |     **25,545** |
| All OS runtime, excluding generated |    174 |         45,012 |
| OS generated declarations           |      2 |             10 |
| Context engine unit tests           |     18 |          7,160 |
| Stream engine unit tests            |      5 |          5,528 |
| SDK unit tests                      |     14 |          4,444 |
| Workers runtime tests               |     71 |         22,129 |
| OS protocol e2e tests               |     49 |         14,429 |
| OS performance tests                |      6 |            725 |
| All OS colocated unit tests         |     61 |         23,573 |

The 50,000-line observation is therefore not reproduced by the narrow core
runtime: that is 25,545 physical lines. It is close to the broader OS runtime
of 45,012 lines, which includes product domains, identity, control plane,
integrations, pages, and runtime-only test support. The narrow core plus the
three directly colocated unit suites is 42,677 lines before Workers and e2e
coverage. The definition matters before setting a reduction target.

`apps/os/src/routeTree.gen.ts` is generated but outside the narrow core and is
not included above. The two generated OS declarations total 10 lines.

## Where the code and tests concentrate

The largest runtime modules are:

| Module                                | Lines | Test counterpart                                        | Lines |
| ------------------------------------- | ----: | ------------------------------------------------------- | ----: |
| `context/built-ins.ts`                | 2,616 | expression/rewrite tests share this contract indirectly | 1,816 |
| `stream/subscription-delivery.ts`     | 1,962 | `subscription-delivery.test.ts`                         | 2,459 |
| `context/facet-host.ts`               | 1,466 | Workers `facets.test.ts`                                | 2,199 |
| `iterate/stream/processor.ts`         | 1,283 | `processor.test.ts` plus `processor-rules.test.ts`      | 2,352 |
| `iterate/api.ts`                      | 1,276 | compile-time use across the SDK suite                   |     — |
| `context/itx-expression-rewriting.ts` | 1,240 | `itx-expression-rewriting.test.ts`                      | 1,816 |
| `stream/stream.ts`                    | 1,030 | `stream.test.ts`                                        |   776 |

This is not a test-to-source ratio deletion list. Each large test names a
different contract:

- [`subscription-delivery.test.ts`](../../apps/os/src/stream/subscription-delivery.test.ts)
  drives push, cursor, and fan-out delivery through the actual `Stream` and a
  fake expression evaluator. Its header excludes memory-budget and real
  receiver coverage. The separate scopes are evidence against merging it into
  a Workers test.
- [`processor.test.ts`](../../packages/iterate/src/stream/processor.test.ts)
  covers author hooks and [`processor-rules.test.ts`](../../packages/iterate/src/stream/processor-rules.test.ts)
  covers the engine's concurrency rules using the same in-memory stream. The
  latter's file header describes that split and its rows cover distinct failure
  timing, re-reduction, and ephemeral-window cases.
- [`itx-expression-rewriting.test.ts`](../../apps/os/src/context/itx-expression-rewriting.test.ts)
  is an executable rule table. Its examples cover resolution, admission, and
  state reduction, which is a sign that the production concepts are currently
  intertwined rather than proof that the table can disappear.
- [`facets.test.ts`](../../apps/os/__workers-tests__/facets.test.ts) exercises
  Durable Object materialization, eviction, loader identity, and native RPC.
  Its runtime fidelity cannot be obtained from the node-level facet host test.

## Safe test consolidation candidates

These are bounded refactors to make before deleting any assertion. Each has a
specific preservation check.

1. **Put delivery mode cases behind one mode fixture.**
   `subscription-delivery.test.ts` repeats setup for push, cursor, and fan-out
   delivery while the rows differ in the delivery state machine. Extract only
   the shared rig construction and operation vocabulary from lines 31–1,896;
   retain one named case per edge condition. The preservation check is that the
   test titles and their terminal assertions remain, and the file stays a
   node-level test. Do not merge it with `cursor-delivery.e2e.test.ts`: that
   e2e file proves the `/api` contract, alarms, and receiver deployment.

2. **Make the rewrite table the single fixture used by reduction checks.**
   The rewrite test's `resolveRows` table begins at line 43, while
   [`core-processor.test.ts`](../../apps/os/src/stream/core-processor.test.ts)
   separately checks replacement, removal, masks, and snapshot changes around
   lines 438–565. A small exported test fixture containing only canonical
   rewrite input and expected resulting state would remove duplicated parsing
   literals while retaining two tests: one for resolution and one for durable
   reduction. First prove the selected cases cover every `reduceCoreEvent`
   branch named by the current core-processor rows.

3. **Use a shared contract matrix for live providers.**
   The RPC suite has three e2e files for values, attach/reconnect, and
   lend/recall/offline, plus node tests in
   [`rpc-stubs.test.ts`](../../apps/os/src/context/rpc-stubs.test.ts) and
   [`rpc-stub-relay.test.ts`](../../apps/os/src/context/rpc-stub-relay.test.ts).
   The e2e files repeat the provider/session setup and baseline-presence
   assertions. Share their setup and state snapshot helper, but keep the files
   separated by observable protocol: value transport, attach order, and
   lifecycle/recall. The test-level invariant is one end-to-end row for each
   observable transition; relay redial and header sanitisation remain unit
   tests.

4. **Replace residency permutations with a declarative capability matrix.**
   [`context-residency.e2e.test.ts`](../../apps/os/e2e/context-residency.e2e.test.ts)
   lines 63–312 contains many variants of the same observable claim: retaining
   a data value or capability does not keep its context resident. Express the
   variants as rows with an explicit retained value, expected context ids, and
   whether a facet is involved. Keep separate rows for a live `RpcTarget`, a
   stashed `env.ITX`, and a website request because those cross different
   runtime boundaries. This reduces fixture boilerplate without reducing the
   slow, deployed-runtime proof.

5. **Delete duplicate rows only after a branch map, not by file size.**
   The available evidence does not establish an exact duplicate between the
   node, Workers, and e2e suites. A candidate deletion needs a table naming the
   production branch, expected outcome, test runtime, and why another test
   proves the same branch at equal or higher fidelity. The current file headers
   generally establish complementary scopes instead.

## Tests that should remain at their current fidelity

- The `createFailing` memory and WebSocket rows pin upstream/runtime defects;
  removing them would leave a workaround with no removal signal. See
  [`memory-budget.test.ts`](../../apps/os/src/stream/memory-budget.test.ts) and
  [`fetch-upgrade-visitor-close.test.ts`](../../apps/os/src/context/fetch-upgrade-visitor-close.test.ts).
- `apps/os/__workers-tests__/` is the only suite with `cloudflare:test`
  controls for hibernation, eviction, alarms, pins, and native RPC. The testing
  guide explicitly assigns that runtime to those gaps.
- The deployed protocol rows assert things a node test cannot: `stream.e2e`
  tests append atomicity and chunking over capnweb; `cursor-delivery.e2e`
  tests delivery and alarms; the RPC e2e rows test a live session and Cap'n Web
  values.

## Recent churn and in-flight work

From the last commit before 2026-09-23 that touched these directories
(`401b24a2b`) through this audited main, context, stream, and SDK paths saw
29,115 added and 14,731 deleted physical diff lines: net +14,384 across 121
files. That measures churn, not retained source growth. The immediately recent
test cleanup commit on main (`80b01d6cd`) says it removed 3,321 test lines by
placing each guarantee at its cheapest layer; this audit agrees with that
direction and finds no evidence to reverse it indiscriminately.

Open pull requests at the audit point were #3442, #3434, #3384, and #3340.
Only #3442 overlaps the narrow core materially. Its `caller-passing` head
changes `context` loader and built-in code, stream wake/cause plumbing, SDK
scope handling, and 16 Workers test files. In particular it replaces
`withItx` call patterns with `using itx = this.getItx()` and adds cause/wake
coverage. Treat it as an integration dependency for any simplification of
provider scopes, hibernation lifetime, or test fixtures; do not independently
rewrite those call sites before it lands.

The other open pull requests are drafts for copybara, docs, and CI test
selection. They do not overlap the core runtime selector, but #3340 may change
which suites run; retain full-suite runs when validating a behavioral
simplification.

## Recommended next measurement

Before changing production code, add a branch-to-test matrix for the five
execution boundaries: append and durable storage, expression resolution,
subscription delivery, live provider lifecycle, and context/facet residency.
For every branch, select one owner test at the cheapest runtime that can prove
it. That provides an evidence-based test reduction plan while the production
layers are simplified.
