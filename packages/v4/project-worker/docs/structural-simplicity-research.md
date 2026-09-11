# Structural simplicity: landing v4 and continuing the research

## Decision

Land the additive v4 implementation within the accepted 15,000-line budget,
with the original session, expression, processor and event contracts preserved.
Use the [production-backed reading guide](reading-guide.md) to teach one idea at
a time. Do not create a second toy runtime or claim an unmeasured sub-5k core.
Operational verification is separate; its current evidence and unresolved
defects remain in [README](../README.md) and the
[preview record](../../../../docs/preview-proof.md).

This conclusion followed five read-only CLI consultations whose reported model
was `claude-fable-5-1`, each explicitly requested at `xhigh`, on 5 September 2026.
The discussion resumed one session so objections could be challenged against
the source rather than collected as independent endorsements. A sixth call
reported `claude-opus-5` despite the explicit Fable setting; it is not counted
as a verified Fable consultation. Decisions below are the implementation
owner's judgments, supported by the linked code and tests.

## What the original teaching plan actually said

The [original tutorial](../../../v3/project-worker/docs/tutorial-build-the-iterate-context.md)
described context, fetch and stream, with a small Part 0 followed by full
implementations. Its ordering note is more specific: live RPC stubs,
expressions, rewrite rules, subscriptions, then processors. Fetch is a parallel
chapter; the stream is the reveal that durable configuration is ordinary data.

The [onion design](../../../v3/project-worker/docs/design-onion-subscriptions-processors.md)
distinguishes physical capabilities from durable names and explains a processor
as a subscription targeting a hosted facet. The later
[as-built surface](../../../v3/project-worker/docs/itx-surface-as-built.md)
corrects older wording about unshadowable built-ins: `itx.builtins` is the fixed
point; short roots are rewriteable. The
[onion-as-structure proposal](../../../v3/project-worker/docs/proposals/itx-surface-C-onion-as-structure.md)
is useful history, not proof that every proposed signature or import ring was adopted.

The guide follows that conceptual order. It first runs a callback, then makes
lifetime, durable naming, delivery and reduced state explain the next idea.
It uses actual production files and public tests. Its link check runs as part
of `pnpm test`; local and opt-in deployed proofs are labeled explicitly.

## The disagreements that changed the outcome

1. **Public roots are not automatically primitives.** An extra spelling on
   `itx` does not introduce a new execution model. Build/check adapt a compiler;
   safe secret/approval views expose existing decisions; Docs composes the
   processor, repository, loader and fetch interfaces. The useful classification
   is physical primitives, synchronous transaction decisions, post-commit
   compositions, and transport/edge adapters. This is not a strict dependency DAG.

2. **Keep atomic repository and trust decisions synchronous.** Moving repository
   projection into an asynchronous application processor would lose parent/head
   compare-and-swap and atomic batch rollback. An expected stream offset is not
   equivalent to “this repository head is unchanged.” The existing
   `StreamCommitParticipant` already supplies the needed synchronous seam.
   [Repository proofs](../e2e/repos.e2e.test.ts),
   [trust proofs](../e2e/provenance.e2e.test.ts).

3. **Do not add a preparation framework just to hide three explicit steps.**
   The Durable Object is the composition root and legitimately knows its domain
   modules. A generic participant list would move that knowledge without
   removing it. More seriously, deleting the synchronous pager's guard against
   unprepared provenance and caller-supplied verification would permit forged
   receipts unless replaced by an equally strong proof. The guard stays.
   [Assembly and pager guard](../src/iterate-context-durable-object.ts).

4. **Measured constraints are not speculative defensive code.** The JSON5 heap
   crash, native RPC result ownership and checkpoint admission failures were
   reproduced. Removing their protections to shrink a diagram would remove
   behavior. The [JSON5 source patch](json5-memory.md) preserves the grammar;
   it does not introduce a smaller arbitrary source limit or a fallback parser.

5. **Keep the native fetch-upgrade transport.** Current workerd does not
   serialize a `Response.webSocket` through an ordinary native RPC result.
   Cap'n Web's own upgrade support does not change that relay-to-DO hop.
   Native `fetch` is a different, supported transport, and hibernating pager
   ownership still matters. The [primary-source research](../../../../docs/native-rpc-fetch-lifecycle-research.md)
   records concrete deletion criteria, not a permanent prohibition.

6. **Distinguish a type reference from a runtime dependency.** The suggested
   `events → provenance → checkpoint` runtime cycle was not real: those imports
   are type-only. They can affect reading order and generated declaration
   closure, but do not justify a runtime layering refactor.

7. **Verify storage semantics at the source that owns them.** The public SQL
   transaction documentation did not establish nested savepoints. Workerd's
   implementation does: depth-named savepoints are released on success and
   rolled back on failure. This supports the existing nested synchronous audit
   transaction; it is not evidence that arbitrary asynchronous participant work
   would be safe. [Pinned workerd source](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/actor-state.c%2B%2B#L730-L775).

## Concrete findings, not just an architecture description

The discussion found that terminal delivery halts and last-pager cleanup were
using the external append door. A configured trust policy could reject those
unsigned mechanical facts. Public tests failed before the two call sites moved
to private system append. That door skips trust admission only; repository and
fetch-policy projections still run. No public system-write capability was added.
[Locked-policy regressions](../e2e/trusted-mechanical-facts.e2e.test.ts).

A further public regression showed that the resume sweep could delete a raw
durable rule naming a provider that had never connected. Absence at resume is
not evidence of a disconnect. The implemented cleanup journals actual last-pager
disconnects while paused, rechecks current presence and naming after resume,
and retains an unresolved obligation across eviction. Public local and deployed
regressions pass; the versioned operational evidence is in the preview record.

The native capability audit found a separate ownership error in the processor
SDK: each fixed-point stream read or append acquired an `ITX.get()` capability
without releasing it. These two operations return only inert stream data, so
their host first used an explicit scoped disposer and awaited the operation
before releasing the resolved context stub. The public no-disable processor
control changed from canceled native calls to normally completed calls, but
the ninth deployment's 144 MiB catch-up failed and a focused repeat recorded
`exceededMemory`. The tenth deployment also disposes each known-inert operation's
native call promise, which owns a separate returned-value pipeline. It has a
full 5/5 resource pass, but repeated reads and catch-ups still encounter a
native reset without an explained deployment or observed OOM at the failed hop.
The small control and isolated green run are not resource acceptance. The
[versioned evidence](../../../../docs/preview-proof.md) keeps those failures and
the successful byte-for-byte durable recovery separate.
Explicit facet disable still cancels in-flight work; that bounded cancellation
is distinct from the resource failure.
Arbitrary loaded code can return or retain live capabilities, so this is not a
blanket disposer around `runScript` or a new timeout on the public ITX API.
[SDK ownership boundary](../src/sdk/stream-processor-durable-object.ts).

The same-name source debate exposed a different issue. A direct spec-carrying
facet call can refresh its startup memo, but normal subscription delivery uses
an elided target with no spec. A public A→B probe kept A running after same-name
re-enablement; the v3 implementation has the same memo path. The retained
[replacement proof](../e2e/processor-facet-same-name-source.e2e.test.ts)
uses explicit disable→enable. Stale source is documented as a limitation, not
promoted into an intended hot-reload contract.

The suggestion that resetting a cursor before a failed halt necessarily restarts
its retry ladder remains unproved. Halt facts are pause-exempt, and a
resource-halted context refuses further append work. That ordering deserves a
targeted reproduction before any claim of a fix.

## Later deployed-only findings

The continued Claude Fable 5.1 xhigh consultations on 6 September challenged
the lifetime diagnosis rather than proposing another capability facade. The
existing scoped SDK ownership was retained. A failed native DO stub is now
invalidated for the next call without replaying the failed operation. Exact
platform reset flags are classified separately from unknown errors and overloads;
idempotent caller recovery has its own bounded proof, not a rewritten no-retry
diagnostic. On version twelve, the full byte-exact 144 MiB read and tally snapshot
completed without a reset and their exact telemetry window was clean.

Public idle tests found a genuine feedback loop: a cold alarm durably appends a
wake, subscription delivery treats that wake as work, and delivery arms another
alarm. Deferring constructor fan-out fixed hosted facets but not stateless
cursors, which read the log directly. The durable cursor reproduction grew from
one wake to seven in 125 seconds. Fable's counterexamples ruled out dropping
wake rows, an incarnation-local cutoff, and a cutoff that relies on a target
looping back into the same context. The resulting narrow design persists the
last activated durable head, keeping passive wake facts durable but deferring
their delivery until real activity. Its final deployed verdict belongs in the
[versioned evidence](../../../../docs/preview-proof.md).

The test harness also needs the actual lifetime contract: `provide` and
`subscribe` return session-owned leases even for expression targets. A test of
durable configuration surviving closed sessions must append the configuration
facts, as applications do, instead of accidentally removing its own fixture.

## The next experiment: additive source-reference ergonomics

The interesting next question is whether platform examples can use small,
durable source references without changing the literal-expression contract.
Producer expressions with an explicit cache key already exist; repository-pinned
build inputs exist too. The current Docs activation instead inlines its built
bundle in a rewrite target. Unlike a hosting subscription, that target remains
in core state and its checkpoint, and rule listing prints it. This is a real
cost of the example, not another conceptual primitive.

An experiment must preserve these observable laws:

- Existing literal inputs and hand-appended events remain admitted under the
  same defined resource contracts. No convenience verb silently rewrites a
  caller's durable event from a literal into a reference.
- `readEvents` preserves the appended body and the established server-derived
  envelope. Literal and reference spellings remain distinguishable and exportable.
- A reference must remain resolvable from durable pinned inputs and the required
  toolchain, or durable immutable content. A bundler cache key alone is not
  sufficient: cache eviction must not strand a durable activation.
- The synchronous reduce does not perform network or worker RPC to dereference
  source. Materialization owns that work and its bounded failures.
- Context isolation, content-derived loader identity, replacement semantics and
  capability disposal remain covered by the unchanged public tests.

This can shrink example targets and repeated core/checkpoint work. It does
**not** delete literal admission, hosting-source elision, the startup-memo
ceiling or the literal parser. Nor does source closure make arbitrary project
replay self-contained: signatures bind their original context, and secrets and
live capabilities have separate ownership. A genuine kernel deletion would
require a different compatibility decision.

Before changing same-name replacement, separately decide whether new source
keeps processor state or starts a clean rebuild. Before adding signed live
attachment, decide how signatures authorize an atomic capability+configuration
handoff. Neither question is answered by a folder rename or a flatter API.
