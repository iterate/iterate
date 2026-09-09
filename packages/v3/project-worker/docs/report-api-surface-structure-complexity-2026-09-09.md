# project-worker — API surface, structure and complexity report (2026-09-09)

State measured: commit `26436c28e` on `wip/kernel-wayfinder-2026-07-30`, deployed as version `fed19375`, after
five review passes (BUILD-LOG.md). Every number below is counted, not estimated: `wc`/`rg` for lines, a
TypeScript-compiler scan for functions (cyclomatic proxy = 1 + branches + boolean operators; nesting = depth of
control blocks), and the import declarations for the graph. The scan script and its JSON are in the session
scratchpad (`complexity.mjs`, `complexity.json`).

The last section is the point of the report: the consolidation and refactor map, ranked by what it saves over
what it risks. Annotate there.

---

## 1. Shape in one screen

|                                          |    Lines |          Files | Note                                                                                            |
| ---------------------------------------- | -------: | -------------: | ----------------------------------------------------------------------------------------------- |
| Source (non-test, non-generated)         |   12,676 |             60 | of which 841 are test rigs living in `src/stream`                                               |
| Unit tests (`src/**/*.test.ts`)          |    7,952 |             32 | node, no workerd                                                                                |
| Workers-lane tests (`__workers-tests__`) |    2,705 |   12 + support | miniflare/workerd, raw DO doors                                                                 |
| e2e (`e2e/`)                             |    8,281 | 51 + 9 support | 7,447 in tests + 834 support; local wrangler dev, or the deployed worker with `WORKER_BASE_URL` |
| Test : source                            | 1.49 : 1 |                | 18,938 test lines for 12,676 source lines (11,835 without the rigs)                             |
| Markdown                                 | ≈ 24,000 |             70 | 17 at the package root, 53 under `docs/`                                                        |
| Runtime dependencies                     |        7 |                | capnweb, workers-oauth-provider, MCP server, sqlfu, zod, json5, pako                            |
| Functions scanned                        |      561 |                | 478 with cyclomatic ≤ 5; 7 above 20                                                             |

Read: the source is small for what it does; the weight is in tests (fair, this is a kernel) and in
markdown (not fair — two thirds of it is history that reads as if it were current). The complexity is
concentrated in five functions and two classes, named in §4.

---

## 2. Folder and file structure

### 2.1 The tree, with lines (source / tests in that folder)

```
packages/v3/project-worker
├── src/                                  2,429 / 267     the edge and the identity door
│   ├── worker.ts                           298          the ONE fetch: hops, project host, /version, /api, /expression, control plane
│   ├── iterate-context.ts                  462          the capnweb proxy in front of the DO: cd, invoke, provide, subscribe, enable/disableProcessor
│   ├── iterate-context-durable-object.ts 1,012          THE CONTEXT: stream + core reduce + delivery + facets + transport + doors
│   ├── session.ts / session-teardown.ts    225 / 44     authenticate() → Session → projects.list/get/create; the session's lends
│   ├── principal.ts                        131          ONE signed-claims codec (session cookie, project token)
│   ├── project-host.ts / app-config.ts      79 / 111    <app>--<projectId>.<base>; the seven APP_CONFIG_* vars
│   ├── itx-entrypoint.ts / types.ts         64 / 13     the loaded worker's env.ITX; the type-only public surface
│   ├── context/                          3,488 / 2,094   what a call is and how it finds its target
│   │   ├── expression.ts                   281          parse / print / prefix — the itx-expression codec
│   │   ├── itx-expression-rewriting.ts     517          the seven rules, the ONE rule event, the resolver
│   │   ├── dispatch.ts / dotted-path-proxy.ts / invoke-handle.ts   98 / 168 / 84   walk the steps; the dotted sugar; handles
│   │   ├── built-ins.ts / built-in-roots.ts 536 / 42     the physical roots (one 180-line literal) and their names
│   │   ├── rpc-stub-directory.ts / rpc-stub-relay.ts    418 / 232   borrowed stubs + pagers; the edge's lend
│   │   ├── worker-loader.ts                264          the Worker Loader door (cacheKey contract, the dead-isolate workaround)
│   │   ├── durable-object-names.ts          62          the ONE DO-name codec
│   │   ├── repos.ts / git-wire.ts          174 / 625    itx.repos (two verbs) over a copied git-over-HTTPS engine
│   ├── stream/                           4,022 / 4,367   the log, its reduce, its delivery
│   │   ├── stream.ts                       655          append pipeline, read budget, waitForEvent, the alarm armer, the breaker
│   │   ├── core-processor.ts               478          the core reduce: rules, subscriptions, secrets, pause, identity
│   │   ├── subscription-delivery.ts        802          push rows, cursor rows, ladders, three byte budgets
│   │   ├── processor.ts                    558          StreamProcessor + ProcessorEngine (facet-side reduce/process/checkpoint)
│   │   ├── stream-storage.ts / reduce-checkpoint.ts     238 / 119   the typed SQL tables; the versioned checkpoint
│   │   ├── live-state.ts / subscriptions.ts / events.ts 175 / 60 / 67
│   │   ├── memory-budget-scenarios.ts / test-support.ts 730 / 111   TEST RIGS in src (imported by tests only)
│   │   └── node-sqlite-durable-object-storage.ts        41    the unit lane's storage
│   ├── control-plane/                      508 / 0       login + session, OAuth AS, /mcp, D1 directory, console
│   ├── library/                            931 / 940     connectToMcp / OpenApi / Capnweb, serveMcp, the memo table
│   ├── fetch/                              340 / 81      egress (secret substitution), the rpc-stub fetch leg
│   ├── lib/                                251 / 93      errors, patch (JSON diff/apply), timeout
│   ├── client/                             460 / 110     live-state client + store, the React hook, the /demo page
│   ├── sdk/                                247 / 0       StreamProcessorDurableObject, ConfigWorker, defineProcessorContract
│   └── generated/processor-sdk.ts            2           built by build-sdk.mjs (gitignored)
├── __workers-tests__/                    2,705           12 files: DO doors, alarms/quiesce, control plane, degradation, hibernation
├── e2e/                                  7,447           51 files by subject + support/ (client, sources, targets, project-host, principal)
├── docs/                                  53 md          living docs, plans, proposals, two review rounds (9 + 11 files), perf
├── research/ · bench/ · specs/ · tasks/   16 · 4 · 1 · 1 files
├── *.md at the root                       17 files       BUILD-LOG (4,358 lines) and 16 others (see §5.5)
└── wrangler.jsonc · wrangler.test.jsonc · vitest.config.ts · build-sdk.mjs · package.json · tsconfig ×4
```

### 2.2 Where the lines are

| Folder              | Source |                    Tests |                                             Comment share of source |
| ------------------- | -----: | -----------------------: | ------------------------------------------------------------------: |
| `src/stream`        |  4,022 |                    4,367 |                           35–46 % (stream.ts 40 %, live-state 46 %) |
| `src/context`       |  3,488 |                    2,094 | 10–54 % (git-wire 10 %, dotted-path-proxy 50 %, invoke-handle 54 %) |
| `src/` root         |  2,429 |                      267 |                                                             26–47 % |
| `src/library`       |    931 |                      940 |                                                             13–37 % |
| `src/control-plane` |    508 | 0 (workers lane pins it) |                                                              6–26 % |
| `src/client`        |    460 |                      110 |                                                             12–45 % |
| `src/fetch`         |    340 |                       81 |                                                             33–43 % |
| `src/lib`           |    251 |                       93 |                                                             17–27 % |
| `src/sdk`           |    247 |                        0 |                                                             24–56 % |

Comment density is a signal both ways: the core files carry their decisions in prose (a feature), and the
scan in §4.4 shows a third of that prose restates the code beneath it.

---

## 3. API surface

### 3.1 The client's surface, top to bottom (capnweb over `/api`)

```
UnauthenticatedSession
  .authenticate({ projectToken? })              → Session
Session
  .whoami()                                     → SessionPrincipal | null
  .projects.list() / .get(projectId) / .create({ slug })   → IterateContext (a project's ROOT context)
IterateContext                                  the edge proxy; everything else rides `invoke`
  .cd(path)                                     → IterateContext (pure addressing, zero hops)
  .invoke(call, ...liveArgs)                    → unknown   (the ONE dispatch door; the dotted sugar reduces to it)
  .provide(match, target | stub | null)         → RewriteRuleHandle (disposable; `using`)
  .subscribe({ name?, target, consumes?, afterOffset? })   → SubscriptionHandle (disposable)
  .enableProcessor(name, spec) / .disableProcessor(name)
  .<anything>.<dotted>(…)                       → invoke([...steps])  (prototype fallback; the natural surface)
```

The built-in roots a call can reach (`BuiltInScope`, `context/built-ins.ts`) — every one is also spelled
physically as `itx.builtins.<root>`:

| Root                                     | Members                                                                        | Backing                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `whoami`                                 | `()`                                                                           | the DO's identity                                                             |
| `kv`                                     | get, put, delete, list                                                         | `ITX_KV`, project-prefixed                                                    |
| `secrets`                                | set, delete, list (write-only)                                                 | `SECRETS_KV` + the core catalog; egress substitutes `{{secret:project:NAME}}` |
| `ai`                                     | the Workers AI binding, verbatim                                               | `AI`                                                                          |
| `cfArtifacts`                            | create, get, list, delete                                                      | Cloudflare Artifacts, project-prefixed                                        |
| `repos`                                  | readFile, writeFile                                                            | git over HTTPS on Artifacts (`git-wire.ts`)                                   |
| `append` / `readEvents` / `waitForEvent` | the log                                                                        | `Stream`                                                                      |
| `cd`                                     | `(path)` → the sibling context (carries the principal)                         | Workers RPC to that DO                                                        |
| `fetch`                                  | `(Request)`                                                                    | egress                                                                        |
| `rpcStubs`                               | get, list                                                                      | the borrowed-stub registry                                                    |
| `rewriteRules`                           | list, get, resolve                                                             | the core reduce's table                                                       |
| `facets`                                 | get(name, spec?)                                                               | Worker-Loader-hosted DurableObject classes                                    |
| `subscriptions`                          | list, get                                                                      | the core reduce's table                                                       |
| `workers`                                | get({ source, cacheKey?, className?, props? })                                 | Worker-Loader-hosted entrypoints                                              |
| the library                              | connectToMcp, connectToOpenApi, connectToCapnweb, serveMcp, releaseConnections | `library/index.ts`, memoized per context                                      |

Rewrite rules sit between the two spellings: `itx.<name>` resolves through the context's table (seven rules,
`itx-expression-rewriting.ts` header), `itx.builtins.<name>` never does.

### 3.2 HTTP doors

| Host                        | Path                                                  | What                                                                                                    |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| platform                    | `/api`                                                | capnweb session → `UnauthenticatedSession`                                                              |
| platform                    | `/expression?context=&itx=` (+ `/expression/<path>`)  | the fetch lane: a Request applied to an expression's value; email-mode admission; answers CSP-sandboxed |
| platform                    | `/version`                                            | `<deployId> <environmentName>`                                                                          |
| platform                    | `/demo`                                               | the live-state demo page (kept by decision)                                                             |
| platform                    | `/`, `/login`, `/logout`, `/projects` (POST)          | the console (email mode)                                                                                |
| platform                    | `/authorize`, `/token`, `/register`, `/.well-known/*` | the OAuth AS (`@cloudflare/workers-oauth-provider`)                                                     |
| platform                    | `/mcp`                                                | the control plane's MCP: whoami, list_projects, create_project                                          |
| `<app>--<projectId>.<base>` | `*`                                                   | the app `itx.apps.<app>` of the project's root context; `/.itx/session` sets the project cookie         |

### 3.3 The DO's Workers-RPC doors (`IterateContextDurableObject`)

`append`, `read`, `invoke`, `invokeAs(principal, …)`, `fetch` (the pager attach, the fetch-upgrade leg,
the fetch lane, egress), `alarm`, `lendRpcStub`, `rpcStubTransportState`, and the three hibernatable
WebSocket handlers. No configuration verbs: every change is an appended event.

### 3.4 Events the platform itself writes

`stream/created`, `stream/woken`, `stream/paused`, `stream/resumed`, `stream/subscription-configured`
(+ `ifConfiguredAtOffset`), `stream/subscription-delivery-halted`, `stream/subscription-delivery-resumed`,
`stream/self-wake-halted`, `itx/rewrite-rule-configured` (+ `ifTarget`), `secrets/changed`,
`live-state/changed` (ephemeral), `rpc-stub/attached` and `rpc-stub/detached` (ephemeral). Twelve durable
shapes; the core reduce (`core-processor.ts`, contract 8.0.0) folds nine of them.

### 3.5 What ships to loaded code and to clients

| Surface                                     | Members                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.ITX.get()` in a loaded worker          | the real `IterateContext` RpcTarget (no client SDK)                                                                                                                             |
| SDK (`src/sdk`, bundled by `build-sdk.mjs`) | `StreamProcessorDurableObject`, `ConfigWorker`, `defineProcessorContract`, `LiveState`, `jsonEqual`/`diff`/`applyPatch`, `z`, the capnweb session constructors, the event types |
| `package.json` exports                      | `./types` (type-only: IterateContext, UnauthenticatedSession, Principal, BuiltInScope, expressions, events, live-state types), `./client` (`connectLiveState`)                  |
| Configuration                               | `APP_CONFIG_ENVIRONMENT_NAME`, `PROJECT_HOSTNAME_BASE`, `PROJECT_TOKEN_SECRET` (secret), `ARTIFACTS_ACCOUNT_ID`, `ARTIFACTS_NAMESPACE`, `LOGIN_MODE`, `SESSION_SECRET` (secret) |

### 3.6 External dependencies and where each is used

| Dependency                           | Modules                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `capnweb`                            | 11 (the edge, the proxy, session, built-ins, the library ×4, the SDK, the demo) |
| `cloudflare:workers`                 | 6 (the DO, the edge, the relay, the entrypoint, the two SDK bases)              |
| `@modelcontextprotocol/server`       | 2 (`control-plane/mcp.ts`, `library/mcp-server.ts`)                             |
| `@cloudflare/workers-oauth-provider` | 2 (`control-plane/{env,index}.ts`)                                              |
| `zod`                                | 2 (the SDK only)                                                                |
| `sqlfu`                              | 1 (`control-plane/directory.ts`, five queries)                                  |
| `json5`                              | 1 (`expression.ts` — literal args)                                              |
| `pako`                               | 1 (`git-wire.ts` — pack inflate/deflate)                                        |
| `react`, `react-dom`                 | the `/demo` page and the hook                                                   |

---

## 4. Complexity

### 4.1 Distribution

561 functions: 478 at cyclomatic ≤ 5, 55 at 6–10, 21 at 11–20, 7 above 20. 29 functions are longer than 50
lines, 9 longer than 100. The tail is where the risk is; the body is flat.

### 4.2 The tail: functions above 20, or above 100 lines, or nested 5+ deep

|  CC | Lines | Depth | Function                                                                 | What it is                                                          |
| --: | ----: | ----: | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
|  39 |   146 |     3 | `CoreStreamProcessor.#reduce` (core-processor.ts:331)                    | nine event cases in one switch; the rules and subscriptions tables  |
|  33 |   165 |     6 | `SubscriptionDelivery.#deliverFromCursor` (subscription-delivery.ts:636) | the cursor lane: read branch, pushed branch, the ladder, the budget |
|  27 |   166 |     3 | `IterateContextDurableObject.#invokeFacet` (…durable-object.ts:663)      | materialize + call + watchdog + the dead-isolate workaround         |
|  26 |   168 |     3 | `Stream.append` (stream.ts:297)                                          | the whole commit pipeline                                           |
|  26 |   163 |     3 | `worker.ts` `fetch` (worker.ts:134)                                      | every door of the platform host in one function                     |
|  24 |    58 |     6 | `OpenApiConnection.call` (openapi.ts:88)                                 | path/query/header/cookie/body in one loop                           |
|  21 |    41 |     5 | `parseReceivePackResponse` (git-wire.ts:534)                             | git's sideband demux                                                |
|  20 |   138 |     4 | `parsePack` (git-wire.ts:292)                                            | the pack reader, deltas included                                    |
|  17 |    59 |     2 | `control-plane/app.ts` `fetch` (app.ts:118)                              | five routes in one if-chain                                         |
|  17 |    40 |     4 | `applyPatch` (lib/patch.ts:81)                                           | JSON patch                                                          |
|  14 |    98 |     4 | `SubscriptionDelivery.#deliverEventBatch` (subscription-delivery.ts:458) | the push lane                                                       |
|  11 |    56 |     6 | `expression.ts` `parse` (expression.ts:103)                              | the itx-expression parser                                           |
|   1 |   180 |     0 | `buildBuiltIns` (built-ins.ts:356)                                       | one object literal: the whole physical surface                      |
|   1 |   125 |     0 | `projectScopedRepos` (repos.ts:49)                                       | two verbs and their helpers                                         |
|   6 |   116 |     1 | `lendRpcStubOverPager` (rpc-stub-relay.ts:116)                           | the edge's lend over the pager socket                               |

Reading: three of the five heaviest functions are the deliberate "one pipeline, top to bottom" shapes
(`append`, the core `#reduce`, the edge `fetch`) — long by design, each a numbered sequence. The other two
(`#deliverFromCursor`, `#invokeFacet`) are long because several mechanisms share one body; §5 proposes the
seams.

### 4.3 The classes

| Class                         | Lines | Members | Private | Where                                                         |
| ----------------------------- | ----: | ------: | ------: | ------------------------------------------------------------- |
| `IterateContextDurableObject` |   868 |      42 |      30 | the context: 22 imports, the highest fan-out in the package   |
| `SubscriptionDelivery`        |   682 |      36 |      32 | the delivery loop                                             |
| `Stream`                      |   512 |      30 |      14 | the log                                                       |
| `ProcessorEngine`             |   405 |      27 |      19 | the facet-side engine (StreamProcessor is 29 lines beside it) |
| `IterateContext`              |   322 |      19 |      12 | the edge proxy                                                |
| `RpcStubDirectory`            |   316 |      24 |      14 | borrowed stubs + pagers                                       |
| `StreamStorage`               |   192 |      17 |       3 | the typed tables                                              |
| `CoreStreamProcessor`         |   181 |       4 |       1 | the core reduce                                               |
| `LiveState`                   |   130 |      13 |       8 | live-state deltas                                             |

### 4.4 Comment density

Source is 30 % comment lines overall; the core files sit at 35–54 %. The decision comments (why a number,
why an order, what a red pin means) are the package's memory and should stay. The scan of headers against
bodies in §5.6 puts the restating share (a comment saying what the next line does) at roughly a third of
comment lines in the six densest files.

### 4.5 The import graph

Fan-in (who is imported most): `context/expression` 18, `stream/events` 17, `lib/errors` 16, then
`principal` 8, `stream/processor` 8, `app-config` 7, `context/invoke-handle` 7, `lib/patch` 7. Those are the
right hubs: the codec, the event shape, the error shape.

Fan-out (who imports most): the DO 22, `iterate-context` 13, `worker` 13, `memory-budget-scenarios` 11,
`built-ins` 10, `subscription-delivery` 10.

Two import cycles (type-level, harmless at runtime, but they blur seams):

1. `context/built-ins` ↔ `library/index` ↔ `library/{capnweb,mcp,mcp-server,openapi}` ↔ `context/repos` —
   the library needs the `LibraryItx` slice of the built-ins, the built-ins spread `deps.library`, repos
   imports the Artifacts type from built-ins.
2. `iterate-context` ↔ `itx-entrypoint` ↔ `iterate-context-durable-object` ↔ `context/rpc-stub-relay` —
   the DO builds an `ItxEntrypoint` for loaded code, the entrypoint hands out an `IterateContext`, the
   proxy names the DO's type, the relay names both.

### 4.6 Churn (last 30 days, commits touching the file)

`worker.ts` 111, the DO 61, `context/built-ins.ts` 37, `stream.ts` 33, `subscription-delivery.ts` 31,
`iterate-context.ts` 31, `core-processor.ts` 27. The edge and the DO are where every pass's bugs landed;
§5 treats them first.

---

## 5. Consolidation and refactor map

Ranked by (lines or concepts saved) over risk. Each row names the change, counts the delta, and names the
test that pins it. DELETE / MERGE / MOVE / SPLIT is the kind of change. The three area maps below were
produced by independent read-only analysts over the measured tree and verified against it; my own
observations follow in §5.4.

### 5.1 The stream and the context DO (`src/stream/**`, the DO, the SDK, the loader)

Area: ≈ 4,700 source lines. Unit pins green at the time of reading (118 passed, 1 expected fail across the
five stream test files). Five passes already took the big cuts here; what remains is copies and prose.

| #   | Change                                                  | Kind     | Today                                                                                                                                                                                                                                                                                                                        | After                                                                                                                                                                        |                        Δ LOC | Risk · pins                                                                                                                                      |
| --- | ------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Comments that say it a second time                      | DELETE   | ≈ 420 restating lines across ten files (§5.6); the self-wake breaker is told at eight sites (≈ 60 lines)                                                                                                                                                                                                                     | one pointer per decision; the DO header cut to its last five lines                                                                                                           |      **−100** (conservative) | none                                                                                                                                             |
| 2   | One delivery record per subscription row                | MERGE    | `subscription-delivery.ts:124-172` — eight per-name `Map`/`Set`s (`#deliveryChainBySubscription`, `#pendingPushByRow`, `#lastDeliveredThroughOffset`, `#pushedEventBatches`, `#cursorDeliveryRunning`, `#cursors`, `#pushSubscriptionNames`, `#evaluatedTargetHeadByRow`); `#forgetSubscription :434-442` deletes from seven | `Map<name, row>` with those eight as fields; forget is one delete; the push/cursor bit is SET where the head is evaluated (`:281, :478-483, :742`), behaviour byte-identical |                      **−30** | medium, every path touches it · `subscription-delivery.test.ts`, memory rows, `alarm-quiesce`, `uncontrolled-degradation`, e2e `push-delivery-*` |
| 3   | One chars semaphore, two instances                      | MERGE    | `:375-411` — the in-flight acquire/release/wait exists twice (push lane, cursor read) plus an inline try-take at `:492-504`                                                                                                                                                                                                  | one 15-line budget with `acquire`, `release`, `tryTake`; two instances                                                                                                       |                      **−18** | low · memory rows "20 behind cursor rows", "backlog × rows"; e2e `push-delivery-no-dropped-warns`                                                |
| 4   | Drop the per-row pending budget                         | DELETE   | four constants all `8 MiB` (`:51, :61, :72, :76`); `#queuePushBehindInFlightDelivery` trims THIS row (`:309`) then the LARGEST row (`:310`)                                                                                                                                                                                  | with per-row = total, a row over the bound is necessarily the largest and the one that grew, so `:310` alone yields the same drops                                           | **−8**, four budgets → three | low-medium — an argument, so soak it (coupled constants)                                                                                         |
| 5   | `memoryStorage` becomes the real table over node:sqlite | MERGE    | `test-support.ts:88-107` reimplements `ReduceCheckpointStore` (`reduce-checkpoint.ts:40-49`) to count writes                                                                                                                                                                                                                 | a six-line write-counting wrapper over `ReduceCheckpointTable(nodeSqliteDurableObjectStorage().sql)`; the interface goes                                                     |      **−20**, one seam fewer | low, unit lane only · `processor.test.ts` write counts                                                                                           |
| 6   | `CoreStreamProcessor` is not a processor                | DELETE   | `core-processor.ts:294-334` — a class around `contract` + `reduceBatch` + `reduce`; nothing pushes or hosts it (its own header says so)                                                                                                                                                                                      | `reduceCoreEventBatch(events, state, onError)` + `reduceCoreEvent(args)`; `Stream` imports `CoreContract` directly                                                           |   **−12**, one misnamed noun | low · `core-processor.test.ts`                                                                                                                   |
| 7   | One `#withItx` in the SDK host                          | MERGE    | `stream-processor-durable-object.ts:91-112` — `append` and `read` are the same get/await/dispose block twice                                                                                                                                                                                                                 | an eight-line helper                                                                                                                                                         |                      **−10** | low · e2e processor fixtures                                                                                                                     |
| 8   | Split `#invokeFacet` in two                             | SPLIT    | DO `:663-828`, 166 lines, cyclomatic 27: memo resolution (`:691-737`, with the M1 log recovery) then load/call/copy                                                                                                                                                                                                          | `#facetStartupMemoFor(name, spec)`, a private method                                                                                                                         |         0, cc 27 → ≈ 12 + 10 | low · `alarm-quiesce`, e2e `processor-facet-enable-disable-lineage`                                                                              |
| 9   | The two read views beside their row types               | MOVE     | DO `#rewriteRuleList :397-418`, `#subscriptionList :525-547` are pure over (core state, cursor); their row types live in `built-ins.ts:41-56`                                                                                                                                                                                | build the views in `built-ins.ts` from `coreReducedState()` + `cursor(name)` deps                                                                                            |                       **−5** | low                                                                                                                                              |
| 10  | Dead `waitUntilProcessed` on `core`                     | DELETE   | DO `:683`; only `snapshot` is ever called on `facets.get('core')` (22 sites, none for the barrier)                                                                                                                                                                                                                           | delete the line                                                                                                                                                              |                           −1 | none                                                                                                                                             |
| —   | LiveState's cross-hop ordering chain                    | declined | `live-state.ts:54-70, :137-167` (48 lines) exist because one class serves a same-isolate sink and a cross-hop one                                                                                                                                                                                                            | ordering could be the sink's job (≈ −29)                                                                                                                                     |                              | **medium-high** — a measured 14 % reorder on the deployed edge holds it up                                                                       |

**The DO's 42 members, grouped** (identity 8 lines · transport 113 · stream + append door 112 · dispatch +
built-ins + read views 168 · delivery wiring 10 · quiesce + breaker 106 · facets 195 · fetch door + egress
103 · constructor 38): the two groups with a clean seam are already modules with two callbacks each
(`RpcStubDirectory`, `SubscriptionDelivery`). The rest interlock — `#invokeFacet` reads nine things off
`this`; the quiesce reads facets, stubs and the library. A `FacetHost` module costs ≈ +35 lines and one noun
for zero deletion. Verdict: keep the class; the split that pays is the private one (#8).

**Budgets and memos.** Four `8 MiB` constants are two bounds: what is held BACK (pending, cross-row,
oldest dropped) and what is held OUT (in flight, waited for). The two in-flight ledgers are deliberately
separate (a cursor's worst-case page must not trip a live-client drop) but one mechanism (#3); the per-row
pending bound is subsumed by the total (#4). The "two memos" are one evaluation with two invalidation
rules; fold them into one row record (#2) and keep the bit a field.

**Processor shapes.** Five classes: `StreamProcessor` (the author's pure class), `ProcessorEngine` (the
node-testable driver), `StreamProcessorDurableObject` (the workerd shell), `ConfigWorker` (a stateless
entrypoint host) and `CoreStreamProcessor`. The first four are load-bearing for a reason each; the fifth
is a reduce wearing a class (#6). Five → four.

**Rigs in `src`.** `memory-budget-scenarios.ts` (730), `test-support.ts` (111) and the node:sqlite
storage (41) have fan-in 0 from source; the scenarios file must stay a separate entry because the memory
test spawns it under a heap cap. Leave them; stop counting them as source (they are 882 lines, 16 % of
the area).

**Storage seams.** Six named seams; five carry weight (the slice and its node stand-in carry the memory
pins; the SQL handle is the SDK boundary; the two classes ARE the SQL). `ReduceCheckpointStore` exists only
for `memoryStorage` (#5).

### 5.2 The context and the edge (`src/context/**` minus the loader, `src/fetch`, the edge files, `src/lib`)

Area: 27 files, 5,260 lines, 30 % comments. The eleven unit files pinning it pass in 400 ms. This area is
already tight: the wins are doors and nouns, not bulk.

| #   | Change                                             | Kind   | Today                                                                                                                                                                                                                                                                                                  | After                                                                                                                                                                               |                                                               Δ LOC | Risk · pins                                                               |
| --- | -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------: | ------------------------------------------------------------------------- |
| 1   | The codec has ONE normalizing door                 | MERGE  | `toItxExpression` (expression.ts:161-166) and `normalizedItxExpression` (:204-211) differ only in whether an array is shape-checked; `parseItxExpressionPrefix` (:249-273) re-runs the identifier and reserved-name checks per step that `parse` and the shape assert already ran                      | keep `normalizedItxExpression`; the prefix parser is that plus its two prefix-only refusals; delete `toItxExpression`, re-point eight call sites                                    |                                                             **−20** | low · the 1,005-line rule table, expression.test.ts, dispatch.test.ts     |
| 2   | Proxy + handle are one file                        | MERGE  | `dotted-path-proxy.ts` (168; imported by two files) and `invoke-handle.ts` (84); `createItxExpressionPathProxy` is exported for its own test only; the invoke-handle header retells the proxy's workerd story                                                                                          | one `invoke-handle.ts`: the reserved names, the path proxy, the prototype hop, `InvokeHandle`, `walkStepsOnRpcStub`, the brands (the library boundary pin already allows this file) |                                             **−17**, one file fewer | ≈ 0 · dotted-path-proxy.test.ts re-pointed                                |
| 3   | `transportId` → the socket itself                  | MERGE  | rpc-stub-directory.ts:86, :236 (a `randomUUID`), :265-267, :291-301 (`dropRpcStubPager`, public, self-called only), :350-354                                                                                                                                                                           | the attachment carries `rpcStubKey` alone; the replace loop drops every same-key socket that is not this one; `dropRpcStubPager(ws)` goes private                                   |                                             **−14**, one noun fewer | low · e2e `rpc-stubs-lend-recall-and-offline`, rpc-stub-directory.test.ts |
| 4   | `readFile` fetches the blob it already has         | MERGE  | repos.ts:93 fetches the tip's snapshot (which carries every reachable blob), then :119-125 fetches the blob AGAIN                                                                                                                                                                                      | `tipTreeEntries` returns the object map; `readFile` looks the blob up                                                                                                               | **−6**, one HTTP round trip fewer on every config-worker cold start | low · the deployed repos e2e                                              |
| 5   | git-wire to the two verbs' surface                 | DELETE | `GitWireTransport` interface (:578-588, one implementation); `lsRefs(prefixes[])` + `LsRefsEntry` + `parseLsRefs` (both callers pass one ref); `PushReport` + `parseReceivePackResponse` (:529-574, cc 21 — the caller reads `kind` and `detail` only); `tag` rows; `deepen?` optional (always passed) | inferred transport type; `tipOf(ref)`; `pushRefused(body, ref): string \| null`                                                                                                     |                          **−40** (625 → ≈ 585), three exports fewer | low · git-wire.test.ts + the repos e2e                                    |
| 6   | The Artifacts block leaves built-ins.ts            | MOVE   | built-ins.ts:65-143 (79 lines: five interfaces, `ScopedArtifactRepo`, `projectScopedArtifacts`); repos.ts imports `ArtifactsNamespace` back — the seven-node cycle in §4.5; the "fork withheld / prefix wall" story is told FIVE times (30 comment lines)                                              | the block moves to repos.ts (already "the Artifacts binding, one file at a time"); the story told once; the DO's `Env` imports the type from there                                  |                             0 code, **−20** comment, the cycle gone | ≈ 0 · built-ins-artifacts.test.ts                                         |
| 7   | iterate-context.ts header restates its methods     | DELETE | :1-48 — the bullets repeat the method docs nearly verbatim; :43-48 repeats rpc-stub-relay's header; :455-461 repeats dotted-path-proxy                                                                                                                                                                 | header = the invariant + "how a client reaches one"                                                                                                                                 |                                                     **−30** comment | 0                                                                         |
| 8   | The `/.itx/session` door beside its cookie helpers | MOVE   | worker.ts:169-189 (21 lines) is the only user of three project-host.ts exports                                                                                                                                                                                                                         | `projectSessionResponse(url, projectId, secret)` in project-host.ts; worker.ts calls it in one line                                                                                 |                           **−5** net; the edge `fetch` cc 26 → ≈ 21 | low · e2e `ingress-project-host`                                          |
| 9   | Terminal-fetch shape detected three times          | MERGE  | iterate-context.ts:207-217, rpc-stub-directory.ts:181-188, rpc-stub-fetch.ts:46-54                                                                                                                                                                                                                     | one `terminalFetchOf(expression, args)` in rpc-stub-fetch.ts                                                                                                                        |                                                              **−8** | low · e2e `fetch-door-*`                                                  |
| 10  | `secrets` root delegation spelled three times      | MERGE  | built-ins.ts:443-449, :462-465, :475-478                                                                                                                                                                                                                                                               | one closure                                                                                                                                                                         |                                                              **−8** | low · the secrets e2e                                                     |
| 11  | Restatement elsewhere                              | DELETE | dispatch.ts says "pipelined promises are not awaited" three times; rpc-stub-relay.ts explains the shared `lendEnded` reason three times; rpc-stub-directory.ts says "have it · page · offline" three times                                                                                             | once each                                                                                                                                                                           |                                                     **−45** comment | 0                                                                         |
| 12  | Hygiene                                            | DELETE | `signProjectToken` (a one-line alias with two callers), `matchItxExpressionPrefix` exported for its test, `LsRefsEntry`/`PushReport` exported and imported nowhere, `callEntrypoint` 120 lines from its one user                                                                                       | delete, un-export, move                                                                                                                                                             |                                     **−3**, five public names fewer | 0                                                                         |

Not worth it, said explicitly: folding `Session` and `ProjectCollection` breaks the apps/os
`session.projects.list()` shape; `ItxExpressionResolver` as two functions saves ≈ 8 lines for a class with
two fields; the lane's `currentSession` and the control plane's `identity()` are not a duplicate (the lane
stamps no principal in `open` mode by design).

**The expression machinery is six concepts, not eight**: the codec (parse ⇄ print), the prefix (match and
rank), the rewrite (apply plus the `@` fill), the walk (`walkSteps`/`callOn`, fan-in 4), the dotted door
(proxy + hop + `InvokeHandle`) and what-names-a-stub. "Resolve" is rules 3–5 in one function, "handle" is
the dotted door's RpcTarget shape. Two pairs are one thing (#1, #2); two pairs must stay apart (codec vs
rules: the core reduce imports both and the library imports the codec alone; `walkStepsOnRpcStub` vs
`walkSteps`: the boundary pin already refused that merge).

**git-wire** (625 lines, 10 % comments): pkt-line 55 · oid 20 · tree/commit 75 · pack parse 233 · buildPack
28 · v2 requests 56 · receive-pack 58 · transport 49. Serving nothing the two verbs call: ≈ 37 lines (#5).
The 125-line delta resolver is NOT on that list: the probed endpoint sends deltas even in self-contained
packs, and a mis-read pack is the "blank the config worker" bug class passes 2 and 3 fixed.

**The rpc-stub trio** carries nine transport concepts; eight are load-bearing and pinned (the borrowed
table, the pager socket, the page in flight, presence, the broken-stub drop, the keepalive, the lent stub
with its shared `lendEnded` recode, the fetch-upgrade leg with its own delete-day checklist). `transportId`
is the ninth: self-referential and unpinned (#3). Unpinned corners worth one test each: the 10 s page
timeout and "page answered empty"; `clampCloseCode`/`truncateCloseReason`.

**`worker.ts` `fetch`** (163 lines, cc 26): hops 11 · project host 56 (the session door 21 of them) ·
`/version` 3 · `/api` 23 · `/expression` 54 · control plane 5. A route table cannot key these (one by
hostname, one by path prefix, one the catch-all): ≈ +15 lines and an indirection. Three named lane
functions cost ≈ +12 lines of threading for cc ≈ 6/2/9/9 and read about the same. The move that pays is #8.

**`buildBuiltIns`** (180 lines, one literal): the right "one place to see the surface" is the `BuiltInScope`
interface (:153-283); the function is wiring with small entries (kv 25, secrets 40, cd 8, workers 16).
Keep it one literal; #6, #10 and #12 are the splits that help. The type-level `RootsAreTheSameSet` guard
(:285-294) earns its lines.

**`types.ts` / `./client`**: no file in the repo imports `project-worker/types`; the e2e client imports
capnweb alone. Of 13 exports, `ProjectTokenClaims` is a platform-side minting type and two are reachable
through `IterateContext`. The surface is near-minimal (−1 line).

### 5.3 The library, the control plane, the client, the SDK

| #   | Change                                                                                                                                                   | Kind   | Today                                                                                                                                                                                                                                                                                                                                                                          | After                                                                                                                                                             |                                                                        Δ LOC | Risk · pins                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | sqlfu out; the seven queries inline                                                                                                                      | DELETE | `control-plane/sql/` (queries.sql 43 + 277 tracked generated lines), `sqlfu.config.ts` (35, boots Miniflare to introspect a local D1), `.sqlfu/`, the `sqlfu` dependency, the `miniflare` devDependency (its only user), the `sqlfu:generate` script; each query is spelled three times (the .sql, the generated .sql.ts, `sourceSql`) and called once from directory.ts:43-90 | `env.DB.prepare(sql).bind(…)` in directory.ts; the three row interfaces it already declares are the types; `db:schema:remote` stays (plain `wrangler d1 execute`) | **−325**, two dependencies fewer, the only Miniflare-booting build step gone | low · `control-plane.test.ts` (applies definitions.sql via `?raw`), the session and ingress e2e; the generated code already turns `:named` into positional `?`, the SQL text does not change. Closes REFACTORS-LATER.md:27's open question              |
| 2   | One hand-written router                                                                                                                                  | MERGE  | `control-plane/index.ts` (43) + `env.ts` (20) + `ids.ts` (14) beside `app.ts`; four dispatch layers for nine routes (worker.ts, index.ts's open-mode `/mcp` short-circuit, the OAuth provider's own routing, app.ts's if-chain at cc 17)                                                                                                                                       | the two hand-written layers are one file; the provider's routing is the library's                                                                                 |                                                   **−20**, three files fewer | low, same pins                                                                                                                                                                                                                                          |
| 3   | `McpConnection.tools()`                                                                                                                                  | DELETE | mcp.ts:64, no caller outside the library                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                                   |                                                                           −4 | none                                                                                                                                                                                                                                                    |
| 4   | `/demo` without React (owner's call)                                                                                                                     | DELETE | `react.tsx` (93; its only consumer is demo.tsx), `tsconfig.client.json` (14), four React devDependencies, the JSX options in build-sdk.mjs, one tsc run in `typecheck`                                                                                                                                                                                                         | a vanilla-DOM demo over `connectLiveState` (the shipped `./client` export)                                                                                        |                                          **−80**, four devDependencies fewer | medium — deletes the React binding the docs advertise; pins: `specs/live-state-demo.spec.ts` ×2 (the abort pin lives in the client test, not the hook)                                                                                                  |
| 5   | The presence processor source written twice                                                                                                              | MOVE   | demo.tsx:19-35 and e2e/support/sources.ts:93-118 are the same processor                                                                                                                                                                                                                                                                                                        | one source                                                                                                                                                        |                                                                          −14 | none                                                                                                                                                                                                                                                    |
| —   | The library's memo table + `releaseConnections`, `subclassWithMethods`, the `McpJsonRpcClient` split, build-sdk's dual build, `src/sdk`, `src/generated` | KEEP   |                                                                                                                                                                                                                                                                                                                                                                                |                                                                                                                                                                   |                                                                            0 | the memo has ONE production caller (the idle quiesce) and exists because a connector reached through a rule is evaluated per call — without it, one handshake per call (a MAJOR defect in the record); pinned five times in unit and once over the wire |

**Connection shapes.** Six classes, two shapes: a pipelined handle (`CapnwebConnection extends
InvokeHandle`) and method-per-name targets (`McpConnection`, `OpenApiConnection`) sharing the one factory
`subclassWithMethods` (a two-implementation abstraction that earned −27 lines). Folding `McpJsonRpcClient`
into its connection would put `request`/`notify` on a traversable RpcTarget prototype — not recommended.

**The demo chain** (demo.tsx → `useLiveState` → `connectLiveState` → the store, plus the built HTML, the
second esbuild, the Playwright spec) is the minimum for a React demo; the non-minimal parts are #4 and #5.
Splitting build-sdk's two builds saves 0 lines and 0.5 s per test run and adds a script — leave it.

### 5.4 Tests

Ratios by area (source ↔ the tests naming it): stream ≈ 2.1 : 1, control plane ≈ 2.1, library 1.46,
context 1.4, client 0.82. Unit alone is 0.63 : 1.

**e2e rows that re-pin a unit or workers claim** (≈ −210 lines):

| e2e pin                                                                                                                                | already pinned by                                                                     | action                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `context-built-ins-and-error-codes` ":' in the ctx is REJECTED" and "cd('x') = cd('/x')"                                               | `durable-object-names.test.ts` (two rows)                                             | delete both (−30)                                     |
| `rewrite-rules-map-and-chains` "the table is a MAP, null deletes"                                                                      | `do-doors.test.ts` + `core-processor.test.ts`                                         | keep only its concurrency half                        |
| `processor-facet-enable-disable-lineage` stale-handle dispose is a compare-and-set                                                     | `do-doors.test.ts` + `core-processor.test.ts` + `rpc-stubs-reconnect-same-path`       | delete (−29): a third wire pin of one reduce rule     |
| `rpc-stubs-attach-carries-the-rule` paused refuses provide + subscribe                                                                 | `rpc-stub-pager-attach.test.ts` "ATOMIC: a paused stream refuses the attach with 409" | delete (−25)                                          |
| `rpc-stubs-lend-recall-and-offline` x-itx-\* stripped on the fetch lane                                                                | `control-plane.test.ts` + `ingress-project-host`                                      | delete (−11)                                          |
| the consumes rule, pinned FOUR times (`push-delivery-ranges-chain` ×2, `subscriptions-ephemeral-opt-in` whole file, `cursor-delivery`) | `processor.test.ts` "consumesEvent — THE ONE consumes rule"                           | delete the opt-in file (−67) and one ranges row (−14) |
| `stream-wait-for-event` three rows (its own header says the mechanics are stream.test.ts's)                                            | `stream.test.ts` (eight rows)                                                         | keep the loaded-worker-lane row, drop two (−30)       |

**Merge by subject, 51 → 23 files** (every test is self-contained: fresh context, per-test dispose; a
merge is concatenation; headers and imports saved ≈ 28 × 12 ≈ −330 lines): `session` (three files;
`session-wire-frames` stays), `config-worker` (three), `cfartifacts` + `repos`, `library-connectors` (+
behind-the-lane), `context` (two), `rewrite-rules` (three), `rpc-stubs-values` (four), `rpc-stubs-reconnect-
and-attach` (two; `lend-recall-and-offline` stays), `workers-and-facets` (four), `processor-facets` (three),
`push-delivery` (three; `no-dropped-warns` stays, it owns a worker), `cursor-delivery` (+ after-offset),
`fetch-door` (three), `stream` (five), `stream-isolate-ceilings-deployed` (memory-budget + uncontrolled-
degradation, renamed — today's name collides with the workers file while pinning different rows). Total
e2e ≈ **−540 lines**. Risk: the lane runs files in parallel (`fileParallelism: true`), so the 630–830-line
merged files become the critical path; if it slows, split by duration, not subject.

The three lane configs are right-sized; `wrangler.test.jsonc` repeats wrangler.jsonc's bindings because the
plugin cannot drop the `ai` binding — a documented duplication, keep. `e2e/support/principal.ts` +
`worker-config.ts` could fold into `global-setup.ts` (−10) — marginal.

### 5.5 Docs and the top level

96 markdown files, ≈ 31,000 lines. README links six. Every root file except README, LAYERS and BUILD-LOG
already carries a HISTORY or SUPERSEDED banner from 2026-09-03 — the triage is done; the files just never
moved.

| Class             | Files                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIVING (6)        | `README.md`, `LAYERS.md`, `docs/itx-surface-as-built.md`, `docs/clean-room-api-walkthrough.md`, `docs/design-onion-subscriptions-processors.md`, `docs/plan-v4-features-layered-on-v3.md` (its STATUS block is the roadmap; its body still says "fallback to the control-plane shell")                                          |
| HISTORICAL (≈ 87) | `BUILD-LOG.md` (a log; stays at the root), the 13 other root files, `docs/reviews/**` (24 + the 12 codex prompts), `docs/proposals/**`, `docs/perf/**`, seven dated plans and briefs, the 1,242-line tutorial (teaches `runScript`; not linked from README), `research/**`, `tasks/performance-menu.md` ("parked"), this report |
| DEAD (3)          | `docs/state-of-play.md` (links two task files that do not exist; `itx.clients` ×4), `docs/iterate-context.md` (`/call`, `/ws`, `itx.clients`), `docs/proposals/target-partial-application.md` ("research interrupted", superseded the same day)                                                                                 |

**Three living docs contradict the code today:** the walkthrough still declares and demonstrates
`runScript` (:654, :819 — zero hits in `src`), `LAYERS.md:172` gives the old space-joined teardown key
(the code is `JSON.stringify([name, key])`), and the walkthrough's `/authorize` paragraph (:1438) still
describes the project picker (approve / switch account is all that is left). Also `package.json`'s
description names a `src/shared` that does not exist, and BUILD-LOG's header still names the shell worker.

**The folder shape:** README, LAYERS, BUILD-LOG and the four living docs stay where README links them;
everything else moves under `docs/history/`, dated by its own banner
(`git mv ACTION-PLAN.md docs/history/2026-08-28-action-plan.md`, … , `git mv docs/reviews docs/proposals
docs/perf docs/history/`, `git mv research docs/history/research`), the three dead files deleted. One
source comment names `FACET-RPC-INVESTIGATION.md` and the moved files' root-relative links need `../`;
dead links inside history are acceptable.

### 5.6 Comments that restate the code

≈ 3,800 comment lines in source. The two analysts' line-by-line estimates of pure restatement (a comment
saying what the next line does, or a decision told a second and third time):

| Area                       | Comment lines |        Restating | The tell                                                                                                                                                                                          |
| -------------------------- | ------------: | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stream + DO + SDK + loader |         1,561 |            ≈ 420 | the self-wake breaker told at eight sites (≈ 60 lines); the DO header repeats README and LAYERS; field docs that restate field names; a four-version changelog on one line                        |
| context + edge             |         1,580 |            ≈ 185 | iterate-context.ts's header repeats its own method docs; the Artifacts "fork withheld" story five times; "pipelined promises are not awaited" three times; "have it · page · offline" three times |
| **total**                  |     **3,141** | **≈ 600 (19 %)** |                                                                                                                                                                                                   |

The decision comments stay: rewriting's rules 1–7, rpc-stub-fetch's doctrine and fence, dotted-path-proxy's
workerd rationale, dispatch's DataCloneError block, git-wire's probed-behaviour list, M1's source elision,
the loader's `$` cacheKey warning and the dead-isolate workaround, the cursor lane's deadlock note.

### 5.7 Cross-cutting observations and the sequence

Things the three maps see from different sides:

- **The two import cycles both resolve by a MOVE.** Cycle 1 (built-ins ↔ library ↔ repos) goes with
  §5.2 #6 (the Artifacts type model to repos.ts). Cycle 2 (proxy ↔ entrypoint ↔ DO ↔ relay) is type-only
  and load-bearing (the DO mints the entrypoint; the entrypoint hands out the proxy); leave it, or move
  the `IterateContextDurableObjectStub` type beside the DO — cosmetic.
- **"Who" is spelled four ways** (`principal.ts` claims, `control-plane/session.ts` `identity()`,
  `worker.ts` `laneIdentityOf`, `session.ts` `authenticate()`); the analysts checked and none is a
  duplicate (each door stamps a different thing by design). Count them as four concepts, not four copies.
- **Twelve platform event types, nine folded by the core reduce**, three ephemeral. That is the right size;
  no cut.
- **Rigs in `src`** (882 lines) distort every "source LOC" number by 7 %; leave them (the memory test
  spawns one under a heap cap) and count them apart.
- **The long functions are of two kinds.** `Stream.append`, the core `#reduce` and the edge `fetch` are
  numbered pipelines and should stay one body each (the analysts independently declined to split them).
  `#deliverFromCursor` and `#invokeFacet` are several mechanisms in one body; §5.1 #2–#4 and #8 are the
  seams.
- **The SDK contract, the codec door, the DO-name codec, the signed-claims codec** are each ONE door now;
  the remaining two-door cases are §5.2 #1 (the expression codec's second normalizer) and §5.1 #3 (the
  chars semaphore).

**Totals, counted:**

|                                                             |                                                                                                                                         Lines | Also                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------: | ----------------------------------------------------------------------------------------- |
| Source, low risk (§5.1 #1–#10, §5.2 #1–#12, §5.3 #1–#3, #5) |                                                                                                                                    ≈ **−870** | one file, one cycle, one noun, ≈ 8 public names, 2 dependencies, the Miniflare build step |
| Source, owner's call                                        |                                                    −80 (React out of `/demo`), −190 (the self-wake breaker, now that its root cause is fixed) | 4 devDependencies                                                                         |
| Declined by evidence                                        | LiveState's ordering chain (−29), the git-wire delta resolver (−125), the DO split (+35), a worker.ts route table (+15), the library memo (0) |                                                                                           |
| e2e                                                         |                                                                                                                                    ≈ **−540** | 51 → 23 files                                                                             |
| Docs                                                        |                                                                  87 files → `docs/history/`, 3 deleted, 6 living (3 with a one-line fix each) |                                                                                           |

**The sequence I would run**, one small deployed-proven commit each, cheapest-per-risk first:

1. Docs triage (§5.5) — zero code risk, the largest reader win; fix the three contradictions the same day.
2. sqlfu out (§5.3 #1) and the router fold (#2) — −345 lines, two dependencies, one build step.
3. The codec's one door and proxy + handle (§5.2 #1, #2), then `transportId` and the repos double fetch
   (#3, #4), then git-wire to the two verbs (#5) and the Artifacts move that breaks the cycle (#6).
4. The delivery record (§5.1 #2) with the semaphore and the per-row budget in the same pass (#3, #4),
   soaked on the deployed worker; then #5–#10 as housekeeping.
5. The e2e merge (§5.4), watching the lane's wall time.
6. The comment pass (§5.6), file by file, keeping every decision line.
7. The two owner's calls (React, the breaker) when decided.
