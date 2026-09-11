# Iterate project core

An independent experiment beside `../project-worker`, based on the September 4 brief.
The existing clean room and `apps/os` are references, not runtime dependencies.

The runnable experiment uses public context paths, a shared TypeScript capability
contract, native confined workers, and an ordered event log. `project + context
path` is the core address; a file-like namespace or collaborative document
service is optional application work, not a required core resource model.

```ts
import type { Scope } from "./src/types.ts";

declare const project: Scope; // obtained from an authorized RPC session
const review = project.cd("/workspaces/review");
await review.append({ id: "note-1", type: "note.created", data: { text: "Hello" } });
const page = await review.readEvents({ afterOffset: 0 });
```

## Current architectural checkpoint

[Open the isolated domain proof](https://iterate2.com) and enter any email. An
optional configured custom-host example is
[anything.iterate.computer](https://anything.iterate.computer). This is
deliberately **unverified demo identity**; all
projects are shared sandbox data, not private accounts. OAuth uses
`cloudflare/workers-oauth-provider`, not Cloudflare Access. Browser sessions
enter the core through a cookie-stripping adapter; MCP receives a
provider-issued, single-project OAuth grant. Secret writes still require a
separate deployment-admin credential. Do not put real secrets or private data
in this demo.

Start with [ARCHITECTURE.md](ARCHITECTURE.md): the implemented `Scope` contract,
module responsibilities, fixed context/dotted-capability direction, and
optional Docs/build sketches. The target is an architectural PoC whose
implementation grows behind stable interfaces, not a production platform
squeezed into a line budget. **Artifact** means Cloudflare Artifacts; compiled code is a
**bundle** or **build output**, and the SQLite repo demonstration is not that
Cloudflare product.

Hostname ingress is a configured-map PoC, not project authentication.
`iterate2.com` and its single-label project hosts select configured projects;
the explicit `iterate.computer` custom-domain map accepts one app label such
as `anything.iterate.computer`. The map supplies routing only: do not
interpret a hostname or the demo email session as membership, privacy, or
domain ownership. The local mapping proof remains in
[hostname ingress](evidence/hostname-ingress.md); the live, isolated
production-account deployment and its earlier deserialize red result are in
[domain preview](evidence/domain-preview.md).

The hard **<5,000** budget counts shipped implementation: `src/`, `public/`,
configuration, package metadata and scripts (including the counter itself).
`e2e/` is reported separately, never hidden: its public-network tests are not
implementation. Notes, evidence and generated local state remain outside both
figures. Run `pnpm size` for the current three figures and its enforced
implementation result. The latest completed local candidate run passed
**44/44** public-interface tests in **34,341.280084 ms**, with zero skips.
The expanded custom-host test separately passes with `anything`, `docs` and
`preview-123` labels. Current size is **3,799 implementation lines** and
**2,292 E2E lines** (**6,091 combined**, reported but not the implementation
cap). The latest [internal simplification](evidence/core-simplification.md)
removes 62 lines without changing the public contract or removing test cases.
Direct native-shaped `load()` supplies host-owned ITX. The optional
`build.build()` resolves a pinned repo snapshot, bundles TypeScript, and caches
successful code independently of execution authority. See [the loader proof](evidence/native-loader.md)
and [the build proof](evidence/builds.md). Typechecking and activation are not
implemented by this builder.

One installed `mount/fetch` policy now selects internal worker or external
network destinations through `await env.NEXT.to(target)`, then native
`target.fetch(request)`. Real WebSocket upgrades survive the internal route;
ordinary app fetches re-enter the policy. Exact approvals bind its revision,
including a tested replacement while an outbound body is arriving. See
[the one-fetch proof and precise revocation limits](evidence/one-fetch.md).

The isolated `iterate2.com`/`iterate.computer` production-account domain stack
is live. Core version **`f0032a5a-cc05-4ee7-8016-c40452062dfb`** passed **44/44**
public tests with no failures, cancellations, skips or retries in
**38,183.850083 ms**, from **13:40:52.220–13:41:30.705 UTC**. HTTP policies and
destinations load fresh children; RPC and build caches remain independent.
Destination-owned streaming removes the reproduced nested response-carrier
cancellations. A rendezvous test requires the first chunk before the client
releases the tail, and fails a temporary whole-body buffering control. See
[the streaming proof](evidence/fetch-lifetime.md).

The final telemetry audit classifies returned-target teardown, explicit stream
closures, deliberate `Hello.boom` errors and processor-retry warnings. It finds
no unexplained outcome group in that bounded run: all six build RPCs now finish
`ok` after their data-only native pipelines are explicitly disposed. This is
acceptance of the architectural experiment, not production-auth, load or
availability certification. [Build lifetime](evidence/build-rpc-lifetime.md)
records the failed await controls and matching nested-RPC reproduction;
[domain preview](evidence/domain-preview.md) retains the exact current audit
and earlier hostname deserialize failures.
Candidate preview version
**`6e72d24a-caad-49a4-aedf-1b187fd639cc`** and the prior
**`3fb575ba-31c2-410a-8faf-802126770dd6`** run remain distinct historical
dev/preview evidence in [preview evidence](evidence/preview.md).

Start locally, then open `http://localhost:8799` for the eight-layer tutorial:

```sh
pnpm --dir packages/v3/project-core dev --local --port 8799 \
  --var PUBLIC_ORIGIN:http://localhost:8799 \
  --var EGRESS_KEY:QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE \
  --var EXPERIMENT_ADMIN_TOKEN:synthetic-egress-admin-token
# In another terminal; these two credentials are synthetic local fixtures only:
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  pnpm --dir packages/v3/project-core test
pnpm --dir packages/v3/project-core typecheck
pnpm --dir packages/v3/project-core size
```

The HTTP/WebSocket test transport performs the demo login; the MCP test performs
a real authorization-code/PKCE exchange. For a remote full run, set
`WORKER_BASE_URL` and supply that deployment's matching `EGRESS_E2E_ADMIN_TOKEN`.
The three secret-write cases explicitly skip without the latter. Never deploy
the published local fixture credentials.

## Historical operational checkpoint (before email login)

The following table and measurements describe the earlier 34-test baseline.
They are retained as historical evidence, not the current deployment status or
a claim that the future application interfaces are already implemented.

| Requirement                                                  | Intended evidence                                                                            | Status                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Recover intent from ramblings, plans, and Claude sessions    | Source-indexed notes, including superseded decisions                                         | Research recorded below                                                                            |
| Projects containing independently addressable context paths  | Deployed isolation and path-resolution tests                                                 | Local network proof; deployment pending                                                            |
| Durable ordered stream, batch append, replay, live subscribe | Deployed concurrency, reconnect, restart, and backpressure tests                             | Local append/rollback/replay/ACK, graceful restart and SIGKILL proof; deployed recovery pending    |
| A single ingress and egress fetch gate, configured by events | Real dynamic-worker ingress/egress routing tests                                             | Local native-loader network proof                                                                  |
| Confined dynamic code execution                              | Deployed execution and denied bypass tests                                                   | Local native-loader proof; deployment pending                                                      |
| Repositories and a project config worker with `processEvent` | Versioned repo edits activating real code, durable processor progress                        | Local tests, retry stress, SIGKILL during retry/in-flight delivery pass; deployed recovery pending |
| Write-only secrets                                           | Injection, origin binding, redirects, non-disclosure tests                                   | Seven combined egress tests pass with synthetic fixtures                                           |
| Human approval                                               | Request, signed approve/deny, exact-request binding, expiry and replay tests                 | Three local network tests pass                                                                     |
| Platform signature levels and progressive lockdown           | Unsigned bootstrap, verified identity, trusted signature, key rotation tests                 | Ten local cases pass, including within-batch rotation/rollback; deployed proof pending             |
| Rudimentary web interface and MCP server                     | Browser walkthrough and protocol-level MCP tests                                             | Local signed append/live follow and MCP protocol proof                                             |
| Clickable tutorial explaining successive layers              | Runnable examples, source links, browser navigation and visual inspection                    | Eight pages with code and live console; local walkthrough                                          |
| Strictly fewer than 5,000 implementation lines               | Automated implementation count, including UI/config/scripts; public E2Es reported separately | Counter enforced; rerun after every code change                                                    |
| High throughput, low latency and CPU efficiency              | Reproducible deployed benchmarks and CPU/log evidence against the existing core              | Local comparison and CPU sample recorded; deployed performance proof pending                       |
| Deployment-target-independent tests                          | Tests use the public network interface and take a deployment URL                             | Public HTTP/WebSocket tests; second runtime not proven                                             |
| Architectural alternatives in sibling copy folders           | Runnable fork and an evidence-based comparison                                               | Fetch-only fork runs; intentionally lacks durability/confinement                                   |

Historical combined-suite checkpoint: **34 passed, no skips** on local workerd.
The counter reports **4,999 raw authored lines**, including tests and UI;
type checking, repository lint and formatting pass. Rejected native RPC calls
now release their failed pipelines; the processor finalizer owns retry alarms.
The latest full suite and the earlier repeated retry stress have zero extra
runtime cancellations or alarm mismatches. This is not a deployment-ready release; [evidence](evidence/local-verification.md)
records the remaining checks and exact synthetic-fixture command.
Separate evidence covers [local process restart](evidence/local-restart.md) and
two [processor SIGKILL recovery cases](evidence/abrupt-recovery.md),
[their current-source repetition with live readers](evidence/fairness-recovery.md),
[approval and secret recovery across SIGKILL](evidence/egress-recovery.md),
the first [HTTP throughput baseline](evidence/local-throughput.md), and a
[CPU sample and existing-core comparison](evidence/append-cost.md). A single-INSERT
storage change improved local batch throughput by 13–18%; the existing core
remains substantially faster. A subsequent [combined trust read](evidence/trust-read-cost.md)
improved batch throughput another 16–17%. The latest [transaction-local policy read](evidence/transaction-trust-cost.md)
adds 17–18% in its matched run while preserving within-batch rotation,
rollback and historical verification. A [current profile and live-reader probe](evidence/current-profile-and-live-delivery.md)
checks another 302,640 events: concurrent batches reach about 10,800 events/sec,
but live delivery falls behind with roughly 1.3-second p99 observed lag at
16 writers. A [matched scheduling diagnosis](evidence/live-reader-scheduling.md)
checks another 400,000 events: most ACK delay precedes the server handler, and
a temporary reader-aware yield reduces local p99 lag to 7–13 ms at roughly
27% lower write throughput. Removing it restores the lag. The subsequent
[retained fairness change](evidence/live-reader-fairness.md) adds a public
regression test within the same line budget. Final-source probes deliver at
7–8 ms p99 lag with zero observed backlog and 8,159–8,360 events/sec with one
reader. Three-reader probes also show the fast reader keeping up while slow
readers remain limited by their ACK cycle. This is a local tradeoff, not
deployed low-latency or CPU acceptance.
A [current-source process-CPU measurement](evidence/fairness-cpu.md) checks
another 768,000 events, including 384,000 live envelopes. In 64,000-event
cases, median main-workerd CPU is 86.1 µs/event without a reader and
115.0 µs/event with one; unprofiled live p99 remains 7–8 ms. Separate Inspector
samples locate commit/page/GC work, not billable CPU or the timer's isolated cost.
A [canonical-validation simplification](evidence/canonical-validation-cost.md)
removes one redundant traversal without changing the line count. Its 576,000
events replay, but the reverse control does not support a reliable speedup
claim. The final 34-test suite passes with stronger loaded-worker fetch-gate
bypass coverage and unchanged whole-envelope validation.
A [20-second raw-stream ACK lease](evidence/stream-ack-deadline.md)
now releases stalled-reader slots: the 64-reader close/replacement/replay case
passes. Idle transport shutdown can still trail by ten seconds locally; this
is not deployed hostile-load or native-memory acceptance.

No commits, pushes or PRs are part of this task. Deployments use a new experiment
worker identity; existing clean-room or product deployments must not be overwritten.

## Working design

The stream records durable decisions. A context owns its ordered log and derived
state. Dynamic code, routes, trust policy and approvals are installed using events.
Storage, signature verification, confinement and secret injection belong to the
platform because application code cannot safely supply those guarantees itself.

The first architectural comparison is an explicit capability interface versus a
fetch-first interface (`../project-core-fetch`). The research notes must distinguish
capabilities preserved, replaced and still missing; line count alone cannot select
the winner. No miniature reimplementation of the old framework is hidden in shared
packages or generated code to meet the size target.

Research: [sessions](notes/session-history.md), [design history](notes/design-history.md),
[existing core](notes/current-core.md), [older capabilities](notes/legacy-capabilities.md).

Design reading: [domain vocabulary](CONTEXT.md), [path-first identifiers](IDENTIFIERS.md),
[interesting lateral ideas](INTERESTING-IDEAS.md),
[Docs/Tasks capability assessment](notes/userspace-app-assessment.md),
[typed contracts and dynamic builds](notes/typed-surface-and-builds.md),
[Kenton/Cloudflare source patterns](notes/kenton-cloudflare-idioms.md),
and [signatures as provenance](notes/provenance-prior-art.md).
