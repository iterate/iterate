# V4 review — behaviour, standards, and tutorial layering

Reviewed 6 September 2026. Scope: the whole current `packages/v4/project-worker`
implementation, its tests/examples/docs, the shared environment/deployment wiring,
and the authored JSON5 patch. Baseline: working tree at
`b74521b32a6d962b6a39e2b0fd3614bd376ea6fe`, including untracked V4 files; this is
not merely a committed diff review. Unrelated V3/user changes were preserved.

Deployed checks target `https://v4.iterate2.app`, main version
`0b689aaa-a7ce-4b3e-af9a-44eebc9730ee`. No application code was changed or deployed
during this review. The new WebSocket expected-failure test and this report are
the deliverables; temporary diagnostic edits were restored. Nothing was committed
or pushed.

## Verdict

**The architecture has a coherent teaching progression. The implementation is not
yet clean enough to call everything working.** The native WebSocket telemetry
failure is real but is not the only remaining issue.

- Two additional runtime defects were reproduced: lost session-owned cleanup on
  pause, and lost named-ephemeral delivery during asynchronous target classification.
- Trust admission demonstrably excludes unsigned ephemerals. That boundary needs an
  explicit policy decision and regression coverage before treating a locked context
  as a trusted-input execution environment.
- Several concrete boundary/type and React lifecycle issues remain.
- The broad deployed run produced **198 passes, 7 failures, 2 skips**. Six failures
  are traceable to local-only fixture assumptions; the seventh is intermittent and
  remains unclassified. They have not been relabelled as passes.

The code-review skills supplied the separate standards/spec passes; the module-design
review checked what guarantees each layer owns. Independent reviews covered runtime,
capabilities, standards and teaching order, with a separate Claude Fable 5.1 consultation.
React Doctor was used as a hypothesis generator, not as an automatic severity oracle.

## 1. Isolated native WebSocket expected failure

New test:
[`native-websocket-close-telemetry.deployed.e2e.test.ts`](packages/v4/project-worker/e2e/native-websocket-close-telemetry.deployed.e2e.test.ts).
It uses the existing twelve-line `SOURCES.site` echo worker, a fresh synthetic
context, and the existing native **outer Worker → context DO → named loaded
WorkerEntrypoint** fetch path. It does not involve a live RPC provider, another
deployed worker, user data, or a real application.

The setup hook checks the configured account/origin, deployed version, tail
readiness, HTTP 200, echoed payload and client close 1000. It then requires the
outer/default native record with no exposed exceptions/logs. Only the final
assertion that its outcome is `ok` is `test.fails`. Missing telemetry, broken HTTP/WS behaviour, deployment
changes and different native failures remain ordinary failures. A future healthy
result becomes an unexpected pass, forcing removal of the quarantine.

Read-only banner polling establishes tail readiness; the actual WebSocket exchange
is made once, without retry. Tail collection is bounded, uses a unique request path,
retains only reduced records, and deletes only the tail session it created. The two
phases each have a 60-second deadline. DO tail records were not consistently delivered;
the isolated regression therefore asserts the outer request's independently failing
outcome. It does not replace the full parent/DO release audit.

The ordinary assertion was first run red against this deployment. At
**15:09:13.980–981 UTC**, the two native records were `exception` with empty
`exceptions` and `logs`; HTTP/echo/1000 controls passed. A deliberately wrong account
also produced an ordinary setup failure after `test.fails` was enabled, proving
setup failures are not inverted. Tail startup/record delivery itself has been
intermittent; missing-record attempts remain explicitly red, not successful repros.
The final outer-only test reported **1 expected failure** at 15:19:58 UTC. A
temporary assertion accepting the observed `exception` was then run at 15:21:09;
Vitest correctly failed it with `Expect test to fail`. After restoring the intended
`ok` assertion, the test again reported **1 expected failure** at 15:22:31. This
tests the quarantine's unexpected-pass behaviour, not a runtime fix.

Run from `packages/v4/project-worker`:

```sh
doppler run --project project-v4 --config prd -- \
  env WORKER_BASE_URL=https://v4.iterate2.app WORKER_DEMO_LOGIN=1 \
  pnpm exec vitest run --config e2e/vitest.config.ts \
  e2e/native-websocket-close-telemetry.deployed.e2e.test.ts --retry=0
```

This records a known failure, **not a release waiver or proof that the exception is
benign**. The native cause is still unexposed. The existing
[handoff](docs/v4-native-websocket-close-repro.md) contains the canonical trace and
source-backed hypotheses. Expected-failure inversion follows the
[Vitest contract](https://vitest.dev/api/test.html#test-fails).

## 2. Spec and behavioural findings

### F1 — High: session-owned expression cleanup can become permanent

[`iterate-context.ts:492`](packages/v4/project-worker/src/iterate-context.ts#L492)
and the subscription counterpart at line 510 run an ordinary unsigned removal
append under `waitUntil`, ending with `.catch(() => undefined)`. There is no durable
cleanup obligation or resume retry for these expression-target handles.

Executed in the real Workers test runtime:

1. `provide("itx.ghost", "itx.builtins.kv")`.
2. Append `events.iterate.com/stream/paused`.
3. Dispose the provided handle; allow cleanup to run.
4. Resume; read `itx.builtins.rewriteRules.get("itx.ghost")`.

Observed retained row:

```json
{ "match": "itx.ghost", "origin": "context", "target": "itx.builtins.kv" }
```

The equivalent expression subscription also remained, with its original
`configuredAtOffset: 4`. The runtime emitted two `STREAM_PAUSED` uncaught-promise
stacks. This contradicts the documented session lifetime and leaves ownerless
configuration after the stream resumes. The pause mechanism is inherited; the V4
trust-lockdown interaction follows the same unsigned-removal path by source
inspection, but was not separately executed.

**Recommended:** give the context host durable, generation-checked cleanup
obligations and explicit lifecycle authority, matching the stronger live-stub
cleanup model. Prove pause/resume, lockdown, replacement and reconnect. Alternative:
make disposal observably best-effort with an explicit failure receipt and recovery
operation. Merely logging the catch is useful diagnostics but does not restore the
promised lifetime; documenting permanent ghosts is not a correctness fix.

### F2 — Medium: generic subscriptions lose named ephemerals before classification

[`subscription-delivery.ts:76`](packages/v4/project-worker/src/stream/subscription-delivery.ts#L76)
overwrites the pending pushed batch per subscription while asynchronous target
classification is outstanding. The generic/cursor branch at line 245 ignores the
individual queued batch and later reads the latest pushed range or durable log
at line 468. The log cannot recover ephemeral values.

A real `Stream` + `SubscriptionDelivery` + SQLite diagnostic configured a generic
`itx.worker.processEventBatch` target consuming `e`, then synchronously appended
two `e` ephemerals before allowing microtasks to settle. Both review and independent
root reruns produced:

```json
{ "got": [], "cursor": { "confirmedOffset": 1, "attempt": 0 } }
```

This is an inherited V3 defect, not a V4 API-shape regression. Explicitly naming an
ephemeral type should not lose both events merely because the consumer's dispatch
classification is pending. Deliberate lossy live-state deltas with revision repair
are a different contract.

**Recommended:** retain and deliver the ordered initial pushed ranges until
classification completes, within the existing queue budget. Alternative: perform
classification before acknowledging subscription readiness, while accounting for
its latency and failure semantics. Eager classification alone does not remove the
race unless readiness is actually gated. Add the two-back-to-back-appends regression.

### F3 — High if lockdown is an input boundary: unsigned ephemerals bypass trust

[`stream.ts:383`](packages/v4/project-worker/src/stream/stream.ts#L383) skips the
transaction for all-ephemeral batches; mixed batches also skip every ephemeral
before transaction participants run. `TrustPolicyStore.apply` is therefore never
called for them. [`provenance.ts:275`](packages/v4/project-worker/src/provenance.ts#L275)
accepts absent provenance immediately and explicitly refuses _signed_ ephemerals.

Executed with the real Stream, trust store and SQLite: configure `minimumLevel: 1`,
then append unsigned `business.unsigned` with `ephemeral: true`. It is accepted at
offset 2 without verification and is absent from the durable log. The public DO
append path has no additional ephemeral trust check. Source inspection confirms
these events can reach waiters and subscribers/processors that name their type;
a processor-effect exploit was not separately executed.

This does **not** bypass trust on durable policy/repository/rewrite facts. The README
describes durable-write authority, so calling it a universal authorization bypass
would overstate the evidence. The problem is the untaught execution boundary:
trusted durable configuration does not imply trusted transient input.

**Recommended if lockdown covers processor input:** enforce admission for ephemerals
under nonzero trust, preserving level-zero behaviour, and define whether ephemeral
signatures are supported. Alternative: explicitly model ephemerals as unauthenticated
signals and constrain trusted consumers accordingly. Add public locked-policy
ephemeral/waiter/processor tests for whichever contract is selected. Do not silently
change ephemeral persistence or claim durable signatures protect them today.

### F4 — Medium: deployed suite is not environment-independent

The 52-file deployed run began at 14:54:10 UTC, retries disabled. Its seven failures:

| Cases                                   | Observed failure                                                   | Classification / next proof                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch-policy-authority` ×2             | 530 instead of locally expected 500 for `egress.invalid`           | Hard-coded local DNS/fallback outcome; preceding policy checks passed. Use a controlled terminal or separately classified environment expectations, not any-5xx acceptance.      |
| `library-connectors-behind-the-lane` ×3 | Protected deployment returns 401 to server-side connector requests | The browser test cookie is not ambient authority for loaded-worker outbound requests. Supply an explicitly authorized fixture; do not weaken demo authentication.                |
| `review-bugs-round2`, edge #12          | 401 instead of loop-guard 508                                      | Authentication stops the unauthenticated outbound loop before its hop guard. The deployed case does not reach the intended seam.                                                 |
| `rpc-stubs-slack-bridge` ×1             | First post-dispose rejection lacked `NO_ITX_EXPRESSION_MATCH`      | A focused deployed rerun passed. The first-error polling logic can observe an intermediate outcome; exact original cause is still unclassified. A green rerun does not erase it. |

**Recommended:** separate reusable public contracts from local-terminal assumptions
and make deployed authority explicit in fixtures. Alternative: label and run the
local-only cases in a separate lane, with equivalent deployed coverage. The mock
Slack bridge made no real Slack calls. Do not declare the entire matrix green.

### Existing failures still matter

The local suite reports 469 passes, but that includes **six pre-existing
expected failures**: object-dense ingress allocation before admission; missing
worker class; throwing module; throwing constructor; a poison-event facet wedge;
and `deleteAll` under a live incarnation. Their failure-injection logs include
native errors; a green assertion count is not clean telemetry.

Two additional native-provider E2E expected failures remain separate from the new
loaded-worker close repro: a native lent stub cannot return a WebSocket through
ordinary RPC, and a provider lent in one invocation does not survive into another.
Those cases were excluded from the broad deployed run and have not been newly
certified here.

The prior same-version resource run is still **4/5**, with the original no-retry
catch-up snapshot encountering a classified platform reset. The separate bounded
recovery proof passed with one fresh-session retry of a known-pure operation. That
does not make the original no-retry test pass. Same-name processor source replacement
also remains documented as disable-then-enable, not hot replacement.

## 3. Standards review

Canonical `rules/**/*.md` were applied individually with their exclusions; broader
TypeScript/coding conventions were also checked. The explicit compatibility request
justifies public API re-exports and dotted ITX sugar; they are not violations.

| Rule / convention                     | Result                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Explain type casts                    | Concrete non-test violations below.                                                                  |
| Validate unknown shapes at boundaries | Scattered unchecked external data and ad-hoc narrowing remain; use a schema or a domain-owned guard. |
| No lame helpers                       | No blocking finding. Existing domain helpers generally own meaningful work.                          |
| Clear conditionals                    | No material violation found. Value-selecting ternaries and early returns are generally appropriate.  |
| Simplify truthiness checks            | No material violation found; offset zero and absent values often differ intentionally.               |
| No inferable type annotations         | No material violation found; typed empty collections are not redundant.                              |
| No `as any`                           | Violations in the demo and operational probes below.                                                 |

### S1 — Medium: external values are cast into domain values

- [`library/openapi.ts:152`](packages/v4/project-worker/src/library/openapi.ts#L152):
  `(await response.json()) as OpenApiDocument`; parameter arrays are cast again at
  lines 186/193 and destructured without element validation. A remote malformed
  document can fail as an incidental TypeError rather than a classified bad spec.
- [`client/live-state-client.ts:89`](packages/v4/project-worker/src/client/live-state-client.ts#L89):
  JSON copying followed by `as LiveStateDelta` does not validate a remotely supplied
  delta before its key/revision/patch are used. The copy is intentional proxy
  materialization, not merely a slow deep-clone preference.
- [`context/rpc-stub-directory.ts:48`](packages/v4/project-worker/src/context/rpc-stub-directory.ts#L48):
  `JSON.parse(...) as Partial<RpcStubPagerAttachRequest>` validates the key and array
  container, not the event elements; the restored attachment at line 339 is also
  cast directly. This is an internal transport boundary, not a demonstrated public
  ingress exploit.
- [`stream/core-processor.ts:382`](packages/v4/project-worker/src/stream/core-processor.ts#L382):
  payload and control fields are asserted without owning their shape. Malformed raw
  control facts are intentionally retained and skipped by existing compatibility
  tests; this review does not authorize rejecting them at append instead.

**Recommended:** schemas/domain guards at each actual ownership boundary, with
explicit classified malformed-input behaviour. For the core fold, preserve the
raw-fact contract while making failed projection explicit. Alternative: validate
upstream once and pass a genuinely validated union, but only if every replay/raw
append path is covered. Comments alone cannot make untrusted shapes valid.

### S2 — Medium: client/probe types use `any`

[`client/demo.tsx:37`](packages/v4/project-worker/src/client/demo.tsx#L37) uses
`Promise<any>`, `as any`, and `useState<any>()`; the authenticated idle probe uses
similar casts at lines 17–19 and 72. These are outside the test exclusions.

**Recommended:** small structural client interfaces for the consumed capability
surface, reusing existing live-state interfaces. Alternative: a localized `unknown`
bridge with a documented runtime invariant where native/browser WebSocket types
genuinely disagree. Do not replace every dynamic API with an invented full schema.

### S3 — Medium: render-time mutation in the React binding

[`client/react.tsx:33`](packages/v4/project-worker/src/client/react.tsx#L33) assigns
`doorRef.current = opts.door` on every render, and the connection effect later reads
the shared ref. This is not one-time initialization. It violates React's
[render-purity requirement](https://react.dev/reference/react/useRef#caveats) and
creates a concurrent-render lifecycle risk. A user-visible concurrent rendering
failure was not reproduced in this review.

**Recommended:** capture the correct door at committed connection setup without a
render-time mutable bridge; prove key/session switching and abandoned renders.
Alternative: a committed-effect ref update with careful ordering and the same
regressions. Do not suppress the diagnostic without addressing that invariant.

The final diagnostic run scored 64/100 with 27 candidates (one error, 26 warnings).
Two initial schema-naming errors in the new test were corrected. Most remaining performance suggestions
are not established defects: serial awaits may preserve policy/order, and source
lists being short does not justify broad micro-optimization. The login redirect
warning is not an established privileged-action flaw: source enforces same origin,
POST login, and keeps authorization as a separate action.

### S4 — Low: deployment contract duplication and tooling gap

`REQUIRED_SECRETS` is duplicated in `scripts/deploy.ts:20` and
`scripts/generate-deploy-config.ts:18`. Root `package.json:23` and `knip.ts:312`
include V3 but not V4 in the explicit Knip workspace list.

**Recommended:** one small deployment-secret descriptor consumed by both scripts,
and an explicit V4 Knip workspace entry. Alternatives: derive from the typed
environment descriptor, or clearly document intentional exclusion with a scoped
V4 command. These are maintenance/coverage findings, not observed deploy failures;
adding a new generic deployment framework is unnecessary.

## 4. Tutorial layering: what holds, what needs correction

The guide correctly uses one production runtime, not a separate toy implementation.
Teaching order is not falsely equated with strict import rings. The meaningful
categories are physical primitives, transaction decisions, post-commit compositions,
and edge/native-transport adapters.

| Chapter                          | Assessment                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. RPC stubs and leases          | Correct physical/live-authority foundation. Make F1's weaker expression cleanup impossible or explicit.                                                                                                             |
| 2. Expressions / one invoke door | Dotted and string sugar genuinely converge; mid-chain capabilities and pipelining remain real.                                                                                                                      |
| 3. Rewrite rules / stream commit | Correct fixed `itx.builtins` root and data-driven names; `provide` session scope is already taught.                                                                                                                 |
| 4. Subscriptions                 | Correct consumer-owned versus stream-owned progress distinction. Add that `subscribe()` is session-scoped even for expression targets, unlike a raw durable configuration append. F2 is a real implementation hole. |
| 5. Processors                    | Correctly a subscription to a hosted facet, not a second scheduler. Explicitly contrast durable `enableProcessor` with session-scoped `subscribe`; keep effect/replay and source replacement limits visible.        |
| 6. Fetch                         | Correct shared policy seam and native fetch channel. Functional 101 is not sufficient operational proof; keep the new quarantine distinct from native lent-stub limitations.                                        |
| 7. Atomic domain decisions       | Repos CAS, provenance and approval state belong in the existing transaction, not async processors. Teach ephemeral admission and cleanup authority as first-class boundaries.                                       |
| 8. Public roots / adapters       | Build/check, native loader input, auth, MCP and connectors extend existing seams; flat public names do not imply new kernel primitives.                                                                             |
| 9. Docs composition              | Yjs/live-state/repository/build/router composition is appropriate userspace code. No special Docs kernel mechanism was found.                                                                                       |

Important positive checks: repository head/CAS is revalidated at commit; provenance
decisions are ordered within the durable batch; approval claims are fingerprinted,
one-use and transaction-bound; build sources are pinned; secret writes require
separate deployment-admin authority; OAuth/MCP project scope and ingress header
stripping are explicit.

No established security defect survived scrutiny in the focused capability review.
The speculative Host-header routing concern was withdrawn because no primary-source
proof established a bypass of the actual global-fetch path. Cache-key cardinality is
a capacity decision under the existing full-capability baseline. Plaintext-free,
opaque approval receipts are intentional; a richer review descriptor is a product
enhancement, not evidence that a token can be forged.

Source count: **14,814 implementation lines** against a 15,000 landing budget
(13,727 package + 639 shared environment map + 448 conservatively counted patch
lines). Only 186 lines of headroom remain. The promised conceptual vocabulary is
small; an executable sub-5k teaching implementation is still unmeasured and must
not be claimed. Any substantial cleanup should remove complexity as it adds proof.

## 5. Verification ledger and limitations

| Check                                                     | Result / scope                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Four package TypeScript configurations                    | Passed after the new test's initial type fix.                                                                        |
| Scoped Oxlint, implementation/examples/scripts + new test | 73 rules, zero warnings/errors.                                                                                      |
| Unit suite                                                | 29 files, 392 ordinary passes + 1 expected failure.                                                                  |
| Combined unit + Workers suite                             | 43 files, 463 ordinary passes + 6 expected failures; expected-failure cases emitted native failure-injection logs.   |
| Broad deployed suite                                      | 52 files, 198 passed / 7 failed / 2 opt-in ingress skips; no test retry.                                             |
| Focused deployed mock Slack bridge                        | One subsequent pass; original intermittent failure remains unclassified.                                             |
| Reading guide                                             | All 74 local links resolve; this checks links, not teaching correctness.                                             |
| Implementation budget                                     | 14,814 / 15,000, passed.                                                                                             |
| Prior same-version hosted + sibling-cursor idle proofs    | Both passed; each observed bounded wakes after 125s with the installer session closed. Not rerun during this review. |
| Prior same-version resource acceptance                    | Original 4/5; bounded pure-operation recovery 1/1. Not rerun during this review.                                     |
| Browser UI                                                | Existing two-editor/publish proof is older deployment evidence. No new browser session was run in this review.       |

Local JSON results: `/tmp/v4-review-unit-20260906.json`,
`/tmp/v4-review-all-local-20260906.json`, and
`/tmp/v4-review-deployed-20260906.json`. These are local evidence, not published CI.

The broad deployed run deliberately excluded the local-Wrangler/auth/DNS fixture
lanes, real paid-AI/external-service cases, local HTTP ingress fixtures, isolated
native-provider diagnostics, and heavy resource/throughput/idle lanes run separately
earlier. It is broad public API evidence, not every possible test or clean telemetry
for all 52 files. No full production trace audit accompanied that entire new matrix.

## Recommended order, not an approved implementation plan

1. Retain the narrow native-close reproduction; keep the unresolved category visible.
2. Fix F1's durable lifecycle obligations and F2's bounded ephemeral delivery.
3. Decide and prove F3's trusted-input boundary without breaking level-zero APIs.
4. Correct the deployed fixtures; identify the original Slack disposal outcome.
5. Repair the typed boundaries and React lifecycle; tighten chapter 4/5/7 wording.
6. Rerun both compatibility and deployed operational proofs, counting every existing
   expected failure and exclusion explicitly. Do not spend the 15k budget on wrappers
   that only move complexity elsewhere.

# Plan (TODO)
