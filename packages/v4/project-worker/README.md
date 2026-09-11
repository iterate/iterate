# Project v4: the clean room, extended

`packages/v3/project-worker` is the compatibility baseline. V4 starts from its
current working-tree source, including its fixes. It does not use the replacement
member-array API in `packages/v3/project-core`.

The public shape stays:

```ts
const itx = session.authenticate().projects.get(projectId).cd("/documents/hello");
await itx.append({
  type: "document/changed",
  payload: { text: "Hello" },
  idempotencyKey: "edit-1",
});
await itx.enableProcessor("document", { source, className: "Document" });
await itx.provide("itx.document", "itx.facets.get('document')");
// Application capabilities remain dotted; invoke is also available.
const document = await itx.invoke("itx.document.snapshot()");
```

Context means **project ID + path**. An expression names a capability operation;
a URL routes an HTTP request. These are complementary, not competing identifiers.
“Artifact” refers only to Cloudflare Artifacts.

For the experimental local celld target, see [celld bring-up and test results](docs/celld.md).
`pnpm dev:celld` boots the real V4 entry points; `pnpm e2e:celld` runs the local
compatibility survey. Basic SQLite facets work; the broader suite remains red.

## Compatibility gates

- Preserve the `/api` session and HTTP-batch doors, expression HTTP/WebSocket door,
  physical built-ins, dotted fallback, rewriting, live lending and disposal.
- Preserve the event envelope (`payload`, `metadata`, `source`, `idempotencyKey`,
  `offset`), atomic batches, ephemerals, paging, machine-readable error codes.
- Preserve the processor SDK, facets, reduce/checkpoint lifecycle, replay without
  repeated effects, subscription delivery, recovery and live-state revision rules.
- Keep the original tests, running against v4 source/runtime, not v3 imports.
  Additional tests must prove added behavior through the same public APIs.

No baseline-mode public API removal was found in the source audit. The processor
SDK and its exports are unchanged; context roots and event fields are additive.
Optional configured authentication and trust policy deliberately restrict calls;
an unconfigured context retains the old anonymous, unsigned behavior.

The implementation passes all four typechecks and the complete local
unit/Workers lane: 463 ordinary passes and 6 expected failures in 43 files.
Acceptance is based on **deployed behavior**, per the owner's clarification
on 6 September. Local Wrangler/Miniflare failures are parked tooling findings,
not V4 acceptance blockers; no further local-runtime investigation is planned.
The original no-retry resource diagnostic remains separate from lifecycle
recovery acceptance. Cloudflare's exact `retryable: true`,
`durableObjectReset: true`, non-overloaded exception is an explicitly classified
platform interruption, not proof of an out-of-memory failure. A failed native
stub is discarded for the next call; production does not replay the failed call.
The separate deployed recovery proof permits one visible retry across the whole
144 MiB read and known pure `user-tally` snapshot workflow. Seed writes,
enablement, arbitrary facet calls, overloads and unknown errors are not retried.
The historical stalled seed remains recorded; recovery of durable data does not
turn that failed request into a success. Current versioned evidence and remaining
checks are in [the preview record](../../../docs/preview-proof.md).

The 6 local unit/Workers expected failures are inherited defects: object-dense
native append decoding; missing worker class exports; module and constructor
throws; a reducer throw that wedges replay; and deleting storage under a live
incarnation. The 2 local E2E expected failures cover dynamic live-WebSocket
provider lifetimes. Two additional deployed-only expected-failure probes cover
concurrent reply pressure and large ephemeral fan-out. Expected-failure tests
are known defects, not evidence of working behavior. The formerly crashing
4.5 MiB literal processor target now receives a coded atomic refusal locally
and on the seventh preview deployment, with no installed facet or submitted rows.

For the original conceptual progression and production tests, start with the
[reading guide](docs/reading-guide.md). `pnpm check:docs` checks its local links.
The [structural-simplicity research](docs/structural-simplicity-research.md)
records the original tutorial plan, five Fable consultations, challenged
proposals, concrete findings and the next bounded experiment.
The accepted landing budget is now **15,000 total implementation lines**.
A smaller teaching implementation remains a separate, unproved research goal.

## Available additions

V4 retains the old dotted/session API while adding these independently usable
layers:

- `workers.load(code, { cacheKey? })` accepts Cloudflare-native loader input.
  `workers.get({ source, cacheKey? })` remains the literal-module or
  expression-producing-source convenience. Both load a confined isolate with
  contextual `env.ITX.get()` and the project fetch policy; cache identity includes
  the deployment, owner and submitted content. A producer expression needs an
  explicit `cacheKey`: it must not be hashed as if it were immutable source.
- `repos.get("/path")` exposes immutable content-addressed revisions, atomic
  parent/head checks, and `head()`/`read()`/`list()`. `check(input)` and
  `build(input)` accept direct files or a **pinned** `{ source: { repo, revision },
options }`; a build result is inert loader input, not a running worker.
- Event provenance verifies optional Ed25519 evidence at append time and records
  server-derived signer/level receipts. Trust policy is a durable event; evidence
  is not authorization and does not replace normal event source/processor lineage.
- The shared fetch policy owns encrypted direct secrets, origin binding and
  one-shot approval receipts. Secret bytes are written only through the separate
  deployment-admin `POST /secrets` door; ITX exposes safe receipts only. Legacy
  `{{secret:project:NAME}}` substitution remains at the physical egress terminal.
- `itx.append` is the project's full durable-write capability. Policy and rewrite
  facts have no special control-plane actor: at `minimumLevel: 0`, an unsigned
  holder may change them, including removing an approval gate. An approval token
  restricts a pending dispatch, not a party authorized to rewrite its policy.
  Projects that need lockdown configure `minimumLevel: 2` with trusted keys
  before their policy and rewrite facts; those later facts must carry trusted
  provenance.
- Project and custom hostnames enter the root context's ordinary `itx.fetch`
  policy. A user-space router can send a host to `itx.docs.fetch(request)` and
  must delegate ordinary external requests to `itx.builtins.fetch(request)`, so
  it cannot bypass secret substitution or approval policy.
- The hosted `/demo` live-state explorer and `/docs` collaborative Docs demo
  use the same authenticated ITX surface. The demo login accepts an email-shaped
  string only: it is unverified shared-sandbox data, not a private account or
  project-directory product. OAuth authorization scopes the standard Streamable
  HTTP `/mcp?project=<id>` endpoint; MCP invokes the same ITX expressions rather
  than a parallel capability API.

### Runnable shapes

```ts
const repo = itx.repos.get("/apps/docs");
const head = await repo.head();
const revision = await repo.commit({
  parent: head?.revision ?? null,
  message: "publish docs",
  files: { "src/main.ts": appSource },
});
const input = {
  source: { repo: "/apps/docs", revision: revision.revision },
  options: { entryPoint: "src/main.ts" },
};
const checked = await itx.check(input);
const built = await itx.build(input);
if (checked.status === "checked" && built.status === "built") {
  const app = itx.workers.load(built.code, { cacheKey: built.key });
  await app.fetch(request);
}
```

```ts
// This appends ordinary durable facts; the receipt is the event offset, not a
// mutable task-board or general code-editing API.
const receipt = await itx.append(
  {
    type: "events.iterate.com/docs/activated",
    idempotencyKey: crypto.randomUUID(),
    payload: {
      repo: "/apps/docs",
      revision: revision.revision,
      buildKey: built.key,
      documentPath: "/tasks.md",
    },
  },
  {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    idempotencyKey: crypto.randomUUID(),
    payload: {
      match: "itx.docs",
      target: `itx.workers.load(${JSON.stringify(built.code)}, { cacheKey: ${JSON.stringify(built.key)} })`,
    },
  },
);
```

The activation's pinned repository revision and build key are part of the
durable receipt. Do not replace these calls with the member-array API from
`packages/v3/project-core`.

## Deployment state

`envs.ts` is the reviewed source of truth for deployed environment hostnames,
worker names and Cloudflare resource IDs; Doppler supplies secrets separately.
The v4 configuration is isolated: provisioning a preview creates new resources
and an isolated preview URL rather than reusing existing production bindings.

The isolated preview is at <https://v4.iterate2.app/docs?project=prj_v4_demo>.
Its demo login is explicitly unverified. Two preview browser tabs have converged
on the same Yjs document; reloading retained it. The UI has checked and built a
pinned repository revision, durably activated it, and served its exact document
from both the project hostname and custom hostname after the installer session
closed. Deployed OAuth PKCE and a real MCP ITX write/read also passed.

Version thirteen passes **85 deployed public API/application tests in 19 files**,
including native loading, repository/check/build, provenance, secrets and approval,
OAuth/MCP, Docs convergence, session leases, and HTTP/WebSocket routing. Separate
deployed idle proofs pass for hosted processors and durable stateless subscriptions
whose target writes into a sibling context. Constructor wake facts remain durable;
passive alarms no longer create an endless subscription-delivery cycle.

The original no-retry resource diagnostic is **4/5** on this version: every byte
of the 144 MiB log reads correctly and all three atomic admission refusals pass;
the first catch-up snapshot returns the classified platform reset. The separate
bounded-recovery proof is **1/1**: one fresh-session retry returns tally count 24,
with byte-exact data and one durable configuration. Its native telemetry has no
terminal runtime failure, no error logs, and two correctly classified info records
for that one interruption. This is not a claim that an interrupted call succeeded.
The remaining native WebSocket-close telemetry classification is tracked in the
preview record; the browser-facing upgrade, echo and clean-close assertions pass.

The public Workers handler bounds its work on a continuing rejected upload; the
deployed finite-upload proof does not claim an early response before client EOF.
Local-only Wrangler/Miniflare diagnostics remain historical tooling findings,
outside this deployed acceptance scope.
See [the versioned preview evidence](../../../docs/preview-proof.md).
V4 does not claim a complete task board or general-purpose code-editing product.

## Verification and size

`itx.check(input)` uses the same `skipLibCheck: true` policy as this package's
TypeScript configuration: submitted source is checked against the real emitted
ITX declarations; third-party declaration internals are not rechecked per request.
Without that policy, Cap'n Web 0.12.2's declaration file reports a missing
`node:http` type and two generic-rest-element errors in the worker-only type world.
Those dependency declaration issues are not fixed here. Public-source tests must
still reject nonexistent ITX members and incompatible arguments.

```sh
pnpm --dir packages/v4/project-worker typecheck
pnpm --dir packages/v4/project-worker test:unit
pnpm --dir packages/v4/project-worker e2e
pnpm --dir packages/v4/project-worker test --project workers
```

To run one E2E file, invoke Vitest directly:

```sh
pnpm --dir packages/v4/project-worker exec vitest run --config e2e/vitest.config.ts e2e/<file>.e2e.test.ts
```

`pnpm e2e -- <file>` does not filter the package script's Vitest invocation; it can run the full suite.

The <=15,000 LOC landing budget is for implementation, not tests. Count all first-party
runtime code, including shared imports, once; do not conceal code in generated
strings, wrappers around v3, or renamed test fixtures. Keep code readable.
`pnpm size` counts raw authored package implementation, examples, build/deploy
scripts, configuration and the counter itself; it also reports/counts the shared
root environment map conservatively. Tests and their three Node-only helpers are
reported separately. Generated bundles and declarations are counted at their
authored sources, not counted twice. The measured total is **14,814 lines**:
13,727 package lines, 639 shared environment-map lines (including its unrelated
20-line data-only re-export) and 448 conservatively
counted authored dependency-patch lines. Run `pnpm size` to recheck the budget.

The local Wrangler config has no deployed resource IDs or routes. Generated
deployment configs use only the new v4 resources recorded in root `envs.ts`;
they do not reuse or replace the earlier experiments' workers. API compatibility,
state transitions and clean telemetry are all required before this preview work
is called complete.
