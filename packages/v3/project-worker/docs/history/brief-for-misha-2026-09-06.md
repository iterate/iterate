# The clean room, for Misha (2026-09-06)

> Sources: `docs/itx-surface-as-built.md` (the surface of record, cited as "as-built §n"),
> `docs/assessment-userspace-apps-on-the-clean-room.md` ("assessment §n"), `BUILD-LOG.md`
> entries dated 2026-09-04 and 2026-09-06, `docs/reviews/2026-09-04-round2-narrative-and-layering.md`,
> and the 2026-09-04 jam notes. Where a source says something is open or deferred, this brief
> says so. Nothing here is a decision that a source does not record.

---

## 1. What the clean room is, in five sentences

It is `packages/v3/project-worker`: one stateless edge worker, one Durable Object class with one
instance per `{ projectId, path }`, and one dotted API called `itx` (as-built §1).

Every call on that surface, `itx.kv.get('x')` and `itx.append({…})` alike, is the same thing on the
wire: `invoke(itxExpression)` against the DO (as-built §1, §3).

Everything configurable is an event on that context's append-only log; the DO carries no
configuration verb, and the edge's verbs (`provide`, `subscribe`, `enableProcessor`,
`disableProcessor`) build an event and append it (as-built §1, §4; layering finding L3).

It is not apps/os and shares no code with it: the assessment reads `apps/os` only for calibration,
and lists what would have to be ported or built (assessment §4, §8).

It is a kernel with proofs and no product on it: 47 e2e files run against a deployed worker
(BUILD-LOG 2026-09-06), and the one assessment of a real app (Docs) concludes it cannot be served at
a URL or know who is calling until two gaps are closed (assessment §4, Gaps 1 and 2).

---

## 2. The axioms

Seven things live below userspace. Each is a built-in root: implemented against the DO's `ctx` or
the worker's `env`, and reachable at its physical spelling `itx.builtins.<root>` no matter what the
context's rule table says (as-built §5).

| Axiom                                   | The itx spelling                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The log                                 | `itx.append(...events)` · `itx.readEvents(afterOffset?, limit?)` · `itx.waitForEvent(filter?)`      |
| The rpc-stub registry                   | `itx.rpcStubs.get(rpcStubKey)` · `itx.rpcStubs.list()`                                              |
| The rewrite-rule table                  | `itx.rewriteRules.list()` · `.get(match)` · `.resolve(call)`                                        |
| Subscriptions and the one delivery loop | `itx.subscriptions.list()` · `.get(name)` (the loop runs after every commit)                        |
| The two hosts for loaded code           | `itx.facets.get(name, { source, className })` durable · `itx.workers.get({ source, … })` stateless  |
| The bindings                            | `itx.kv` · `itx.ai` (Workers AI, verbatim) · `itx.fetch(request)` (egress with secret substitution) |
| Addressing                              | `itx.cd(path)` · `itx.whoami()`                                                                     |

**The litmus test.** "Could this be written in a userspace worker?" The answer is a signature: a
thing belongs above the axioms if its only dependency is `itx` itself, the same dotted handle a
loaded worker gets from `env.ITX.get()` (as-built §5, "Two groups of built-ins, one record").

**Two groups sit above them, in one record.**

- **Roots**: everything in the table above, implemented against `ctx` or `env`.
- **The library** (`src/library/`): first-party code that takes only `itx`, so it could move to
  userspace unchanged. Today: `itx.connectToMcp(url, { headers? })`,
  `itx.connectToOpenApi(specOrUrl, …)`, `itx.connectToCapnweb(url, …)`. `src/library/boundary.test.ts`
  pins the import boundary: no runtime import from the stream, the DO, the fetch module, or
  `context/` except `invoke-handle.ts`. `connectToGraphql` is named as the obvious next member and
  **does not exist** (as-built §5).

The surface shows no level: a library verb and a root are spelled the same way.

---

## 3. The decisions of the 2026-09-04 jam

| Decision                                                                                                                                                                                                                                                          | Why, in one line                                                                                                                                                       | Where it lives                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **No `itx.stream` noun.** `append` / `readEvents` / `waitForEvent` stay top-level roots; `subscribe` is a proxy verb that may lend a stub.                                                                                                                        | A noun would add a level nothing needs.                                                                                                                                | as-built §5 roots table; jam notes                                     |
| **`itx.builtins` is THE reserved root** and the fixed point of rewriting.                                                                                                                                                                                         | "Where does the fallback live" and "is `itx.rewriteRules` itself protected" both dissolve once there is exactly one reserved root and everything short-named is a row. | as-built §3, §5, §7; BUILD-LOG 2026-09-04 builtins entry               |
| **Rules first, to one fixed point.** A builtins-rooted call runs as is and never reads the table; any other `itx.…` call resolves through the rows until it is builtins-rooted (32-rewrite budget).                                                               | One loop, one termination condition.                                                                                                                                   | as-built §7 rule 5; `docs/design-onion-subscriptions-processors.md` §3 |
| **The platform rows are implicit.** `itx.<root> ⇒ itx.builtins.<root>` is never stored; it is applied by the resolver when no context row matches, and materialized only for `list()` / `resolve()`.                                                              | The hot path pays nothing, and a context can shadow, mask, or override a root.                                                                                         | as-built §5, §7 rule 5                                                 |
| **A `null` row is a MASK**, not always a delete: kept as a mask when the match shadows a platform row, deletes otherwise. The platform-equivalent target `itx.builtins.<match…>` is what deletes.                                                                 | A dead fake `itx.ai` must give the real one back, not deny it.                                                                                                         | as-built §7; core contract 6.0.0                                       |
| **The door guards.** A match is rooted at `itx`, never at `itx.builtins`, never at a proxy verb (`cd`, `invoke`, `provide`, `subscribe`, `enableProcessor`, `disableProcessor`); a target is rooted at `itx`.                                                     | The sugar never hands its own verbs to the table.                                                                                                                      | as-built §7 rule 6                                                     |
| **The platform never spells a short name.** Every expression the platform writes is `itx.builtins.…`, including the SDK processor host's own `append` / `readEvents`.                                                                                             | A user's row at `itx.facets` or `itx.rpcStubs` then redirects only the user's calls.                                                                                   | as-built §5, §12 (round two); layering finding L2                      |
| **Knob one.** The pager upgrade header carries `{ rpcStubKey, appendEvents }`; the DO appends the rule or row as it accepts the socket, and refuses with 409 plus the code, lending nothing.                                                                      | The DO owns both ends of a lent stub's rule, and `provide(stub)` costs **1 round trip instead of 3**.                                                                  | as-built §6; BUILD-LOG 2026-09-04 knob-one entry                       |
| **Rule 4 stands: a target denotes a VALUE**; calling the match calls that value. "Stubs as properties" was **withdrawn**.                                                                                                                                         | Value semantics keep one meaning for a target.                                                                                                                         | as-built §7 rule 4; jam notes                                          |
| **`@` is the caller's input (rule 7)**, legal only in a target's final step: bare `@` splices the argument list, nested in a literal it is the one argument, `...@` merges the one argument's fields with the template's keys winning. Chosen over `...` and `?`. | Target-side partial application without the tc39 machinery.                                                                                                            | as-built §3, §7 rule 7; BUILD-LOG 2026-09-04 arc two                   |
| **`itx.ai` is `env.AI` verbatim** (`run`, `models`, `gateway`, `toMarkdown`, `autorag`), the first bindings root. Your deterministic-AI test is one row: `provide("itx.ai", fake)`.                                                                               | No wrapper to keep in sync, and the fake is a rewrite rule like any other.                                                                                             | as-built §5, §7 ("Misha's test"), §12 arc two                          |
| **`read` → `readEvents`** on the surface; **`append` stays `append`.**                                                                                                                                                                                            | One-worder that says what it reads.                                                                                                                                    | as-built §12 arc two                                                   |
| **The library tier**, with a test-pinned import boundary.                                                                                                                                                                                                         | The boundary is the litmus test made executable.                                                                                                                       | as-built §5, §12 arc three                                             |
| **The app config is ONE typed object** (`src/app-config.ts`): `APP_CONFIG_*` vars parsed once per isolate by a row table, loud on a bad or unknown variable. Two fields exist because two things read them.                                                       | Configuration is what differs between deployments; a constant is a property of the code.                                                                               | as-built §10, §12 arc four                                             |
| **`invoke(call, ...args)` is public**, and `rewriteRules.resolve(call)` is pure and returns the chain. The law `invoke(x) ≡ invoke(resolve(x).at(-1))` is pinned in the unit table and end to end.                                                                | One door to run, one pure function to explain.                                                                                                                         | as-built §5, §12 (2026-09-04 builtins)                                 |

Deferred in the jam, no customer: **defaults at creation** (events pulled from the project root once
when a context is created).

---

## 4. What Misha can do with it today

Each line is something an e2e file actually does.

1. **Lend a live function and call it by name.**
   `using h = await itx.provide("itx.laptop", { async ping() { return "pong" } })`, then
   `await itx.laptop.ping()`. Killing the session un-sets the rule and the match goes back to
   default-deny (`e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts`, `e2e/itx-surface-tour.e2e.test.ts`).
2. **Write a pure rewrite, no stub.**
   `await itx.provide("itx.grok", "itx.openai.chat")`. The table is a map: five concurrent re-sets of
   one match leave the last committed target, and `null` deletes
   (`e2e/rewrite-rules-map-and-chains.e2e.test.ts`).
3. **Shadow a built-in root with a fake, then template it.**
   `await itx.provide("itx.ai", fake)` shadows AI for one context while `itx.builtins.ai` stays real
   and dispose restores the platform row; the dream row is
   `itx.fable ⇒ itx.ai.run('@cf/meta/llama-3.2-1b-instruct', @)`, and the deployed lane runs one real
   inference through it (`e2e/ai-root-shadow-and-fable.e2e.test.ts`).
4. **Subscribe with a lent callback.**
   `await itx.subscribe({ name: "chain", consumes: ["hit"], target: fn })`. Delivered ranges chain
   across quiet gaps, `{ name, target: null }` stops delivery at the removal offset, and a throwing
   subscriber never hurts the producer (`e2e/push-delivery-ranges-chain.e2e.test.ts`).
5. **Host a processor.**
   `await itx.enableProcessor("presence", { source, className })`, read it with
   `itx.facets.get('presence').snapshot()`, and `disableProcessor` is one event that also deletes the
   facet (`e2e/processor-facet-reduces-and-address.e2e.test.ts`,
   `e2e/processor-facet-enable-disable-lineage.e2e.test.ts`).
6. **Load a worker from inline modules.**
   `itx.workers.get({ source: { "cap.js": src } })` for a stateless entrypoint, or a source
   expression that produces the modules behind a required `cacheKey`, which runs once per cold
   isolate (`e2e/workers-and-facets-sources.e2e.test.ts`).
7. **Dial an MCP or OpenAPI server from inside a context.**
   `itx.connectToMcp(url, { headers })` then `.callTool(name, args)`, proved against the real
   deployed pet shop with a bearer token, not a fixture
   (`e2e/library-connectors-mcp-openapi-capnweb.e2e.test.ts`).
8. **Serve HTTP from the context, or drive it headless.**
   A loaded worker behind a rewrite rule answers `GET` and a WebSocket `101` on the fetch lane
   (`e2e/fetch-door-expression-http-and-websocket.e2e.test.ts`); one-shot HTTP batch at `/api` covers
   a CLI or a cron (`e2e/session-doors.e2e.test.ts`).
9. **Serve an app at a hostname, and know who is calling.**
   `itx.provide("itx.apps.site", "itx.workers.get({ source })")` and the app answers at
   `https://site--<projectId>.project-worker.iterate.com/` with relative assets and WebSockets intact
   (`e2e/ingress-project-host.e2e.test.ts`); `api.authenticate({ projectToken })` then
   `session.whoami()`, and every event that session appends carries `source.principal`
   (`e2e/session-identity.e2e.test.ts`).

---

## 5. Numbers

Measured facts only, each from the source named.

| Fact                                                 | Number                                                                                                                                                                             | Source                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Code lines (non-blank, non-comment, non-test `src/`) | 6,004                                                                                                                                                                              | as-built §11 (recounted 2026-09-04)                             |
| Raw lines including comments and blanks              | 9,394 in 42 files                                                                                                                                                                  | as-built §11                                                    |
| `src/context/expression.ts`, the whole codec         | 97 → 162 → 143 → **144** code lines                                                                                                                                                | BUILD-LOG 2026-09-04 arc two, phase 2, 2026-09-06               |
| Unit + workers lanes                                 | 431 passed / 12 expected fails, 38 files                                                                                                                                           | BUILD-LOG 2026-09-06                                            |
| E2E, local                                           | 176 passed / 2 expected fails / 11 skipped, 45 files, 0 fail                                                                                                                       | BUILD-LOG 2026-09-04 phase-2 board                              |
| E2E, deployed on `live-47 poc 63ec05bc-…`            | 182 passed / 3 failed / 4 expected fails / 2 skipped, 47 files, 13 min                                                                                                             | BUILD-LOG 2026-09-06                                            |
| Round trips per `provide(stub)` / `subscribe(fn)`    | 3 → **1**                                                                                                                                                                          | BUILD-LOG 2026-09-04 knob one                                   |
| Resolver cost, pure function in node                 | 0.13 µs at 0 context rows · 2.36 µs at 300 rows · 0.01–0.04 µs at the fixed point                                                                                                  | BUILD-LOG 2026-09-04 builtins entry                             |
| Ephemeral push throughput, local probe alone         | 54,054 ev/s end to end, p50 17 ms, p95 28 ms, batching 50×                                                                                                                         | BUILD-LOG 2026-09-04 builtins entry                             |
| Durable appends per context                          | ~100/s awaited singly, ~2,900/s batched                                                                                                                                            | assessment §3, citing `docs/perf/2026-09-03-stress-ceilings.md` |
| DO isolate ceiling, deployed, before the memory arc  | a 144 MiB read materialized 151 MB and workerd refused the reply (32 MiB reply cap); a 288 MiB read reset the isolate 3/3. "Tolerates ~150 MiB for one request and kills at ~290." | BUILD-LOG 2026-09-04 memory hygiene                             |
| DO isolate ceiling, deployed, after                  | a 384 MiB log pages in 65 pages of ≤ 3 events, 3/3                                                                                                                                 | BUILD-LOG 2026-09-04 memory hygiene                             |
| Budgets in force                                     | event body 8 MiB (`EVENT_TOO_LARGE`) · read page 8 MiB and 1000 rows, 512 KiB while other reads are outstanding · delivery ledger 16 MiB per context, 8 MiB per row                | as-built §8                                                     |
| Worker upload / startup, last deploy                 | 762 KiB / 6 ms                                                                                                                                                                     | BUILD-LOG 2026-09-06                                            |

The as-built doc's §11 says 431 unit tests with **13** expected fails; the BUILD-LOG's 2026-09-06
board says 12, because `edge#10` flipped from expected-fail to pass that day. The BUILD-LOG is the
later count.

---

## 6. What is open

### (a) The surface's own open list

As-built §12 ends with exactly **one** open item:

- **D. `cd` on the edge and in the built-ins.** Both exist: the edge `cd` returns an edge context so
  `itx.cd('/x').provide(…)` lends in the caller's session with no DO hop; the built-in `cd` exists
  for expressions evaluated inside the DO, where there is no edge. Both are needed as long as
  expressions evaluated inside the DO may name a sibling context. **Recommendation in the doc: keep
  both.** No decision recorded.

### (b) The eight gaps between the kernel and a real app (assessment §4, ranked)

| #   | Gap                                                   | One line                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Project-host ingress — closed 2026-09-06**          | `<label>--<projectId>.<base>` serves `itx.apps.<label>` of the project's root context with the URL verbatim; the apex host is the label `default`; deployed under `*.project-worker.iterate.com` (as-built §10 "Project hosts"). Still open inside the gap: pretty slugs and custom domains, the control plane's directory rows.                                                      |
| 2   | **Identity — closed 2026-09-06**, minimally           | `authenticate({ projectToken })` verifies a signed project token, `session.whoami()` is the principal, `projects.get` is bound to the token's project, the DO stamps `source.principal` on every append (its own field), and a project host turns the token into a cookie the app sees as `x-itx-principal` (as-built §4 "Who"). Still open: the login page and a machine credential. |
| 3   | **No file tree, no repo, no git**                     | Files are buildable in userspace today as a facet with a SQLite table; git is not, and the suggested first cut is the git-wire client (~1,225 lines) in a loaded worker over egress, not a repo DO.                                                                                                                                                                                   |
| 4   | **No timer that survives idle**                       | In-isolate `setTimeout` dies at the 60 s quiesce and facets have no alarm; the proposal is a scheduled append (`deliverAt` or `itx.schedule`), ~80 lines. Friction, not a wall.                                                                                                                                                                                                       |
| 5   | **No catalog of a project's contexts**                | `cd(path)` is pure addressing and nothing lists what exists; the proposal is one `context/created` fact per child plus `itx.contexts.list(prefix?)`, ~60 lines.                                                                                                                                                                                                                       |
| 6   | **Subscription ergonomics**                           | No `replayAfterOffset` on `subscribe` (replay is the client's job today, ~30 lines to add), push is lossy by design behind the backlog budget, and `waitForEvent` filters by type only.                                                                                                                                                                                               |
| 7   | **No secrets write door, no born project credential** | `SECRETS_KV` is read at egress only; nothing in `src/` writes it. ~50 lines, and it depends on Gap 2 for the verifying side.                                                                                                                                                                                                                                                          |
| 8   | **The client contract has no home**                   | The type an app author needs is importable only from the worker's own source; it needs a `types.ts` export map entry. Trivial, and the first thing an app author hits.                                                                                                                                                                                                                |

**Order of work if the goal is "Docs runs inside a project"** (assessment §6): 1. ingress by host (done)
label · 2. identity · 3. the workspace facet in userspace, no platform change · 4. contexts catalog
or the app's own index · 5. git as a fetch · 6. secrets write door and born credential, with the
client types export alongside.

### (c) The menu the review round left

From the BUILD-LOG 2026-09-06 entry:

- **An edge-side in-flight budget.** The `CONCURRENT BIG APPENDS` control now accepts either failure
  shape (a mid-flight 1006 close or a failed upgrade) because the `/api` edge isolate dies under
  8 × 28 MiB. The real fix stays on the menu.
- **The live-state delta reorder**, diagnosed in that entry and fixed the same night: two
  fire-and-forget appends on two fresh capabilities had no ordering, and the second committed first in
  ~14% of rapid pairs on the edge. Fix A (serialize inside `LiveState`) landed as `63c9474ad` — a lone
  delta still emits synchronously, a racing pair queues, the core reduce opts out — proven 10/10 alone
  on the `live-48` deploy (BUILD-LOG 2026-09-06, the live-state entry).
- Two by-design resets stay red on the deployed board (reply queue, append ingress), per the jam notes.
- Also on the menu, per the jam notes and not in the BUILD-LOG: the pinned-call-then-steps rule-4
  corner, and `#pushSubscriptionNames`.

---

## 7. Questions for Misha

1. **Identity.** Built minimally today: the principal is `source.principal`, the DO's own field,
   set from a signed project token the control plane mints after its membership check; a loaded
   worker's `env.ITX` carries no principal (the app gets `x-itx-principal` and attributes its own
   appends). Right shape? And should membership be re-checked live by the worker, or stay the
   token's claim (Gap 2)?
2. **Ingress address.** `itx.apps.<label>`, resolved from the request `Host` by convention
   (`<label>--<projectId>.<base>`, the apex as the label `default`) and passed the URL verbatim into
   the root context's `fetch`, is now built (Gap 1). Is the convention right, and is a slug directory
   (pretty names, custom domains) the control plane's job or the project's own row?
3. **Attribution as the differentiator.** OS attributes commits to the iterate bot because `author`
   is caller data. Stamping the principal at the door is the one place the clean room would be ahead
   of OS rather than behind (assessment §2, Gap 2). Is that worth building before anything else in
   Gap 2?
4. **Defaults at creation** (a context pulling events from the project root once when it is created)
   was deferred in the jam for lack of a customer. Does Misha have one?
5. **Files and git.** Is "git as a fetch from a loaded worker" the right first cut, keeping the
   kernel free of a repo DO, and is a blob primitive (`itx.blobs` over R2, ~80 lines) needed at all
   for what he wants to build? (Gap 3.)
6. **Timers.** Does he need an event that survives idle (`itx.append({ …, deliverAt })` or
   `itx.schedule`), or can his app flush on every accepted write instead? Today every in-isolate
   timer dies at the 60 s quiesce (Gap 4).
7. **`subscribe` replay.** Add `replayAfter` on the row (~30 lines; the cursor lane already knows
   how), or keep replay client-side? The assessment notes the clean room's verb name `subscribe` is
   the one to keep, since the vessel already calls it (Gap 6, finding 1).
8. **Three kernels.** On this branch, `packages/v3/project-worker`, `packages/v3/project-core` (plus
   `project-core-fetch` and `project-core-ws-probe`) and `packages/v4/project-worker`
   (`@iterate-experiments/project-v4`) all exist as sibling packages; everything but
   `project-worker` is untracked in git. Which one is the line we develop?

Bonus, if there is time: the `@` marker cost +121 codec lines against a ~60-line estimate (BUILD-LOG
2026-09-04 arc two). Does it earn them, or does the target-side template come out?
