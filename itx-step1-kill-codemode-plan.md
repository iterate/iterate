# Step 1: kill codemode, birth the itx processor

The first concrete step toward "itx everywhere" (full context:
`itx-everywhere-plan.md`, summarized in _Later steps_ below). Codemode — the
`ctx`-based script execution system — is deleted entirely and replaced by a
**very limited stream processor**: the **itx processor**. Two events drive it:

```text
events.iterate.com/itx/execution-requested    { functionSource, vars?, context? }
events.iterate.com/itx/execution-completed    { requestOffset, ok, result | error }
```

Append an `execution-requested` event to a stream; the itx processor runs the
code against an itx handle; the result comes back as `execution-completed` on
the same stream. That's the whole machine. There is **no `ctx` left
anywhere** — scripts receive `{ itx, vars }`, same signature as `/api/itx/run`
and every other itx execution mode.

These names join the existing itx event family (protocol.ts:165-170 already
emits `events.iterate.com/itx/cap-defined`, `cap-provided`, `cap-revoked`,
`cap-disconnected`, `context-forked` on the project's `/itx` audit stream) —
so a project stream view tells the full story: capabilities appearing,
executions running, results landing.

## Why codemode dies rather than evolves

Codemode's complexity exists to solve a problem itx already solved better:

- **The `ctx` provider model** (tool-provider-registered events, path-based
  registrations, loopback callables) is a parallel capability registry. The
  itx registry + handle built-ins replace it (Law: one dispatch).
- **The function-call event protocol** (`function-call-requested` /
  `function-call-completed`, stream-mediated results, pending-promise
  bookkeeping in the DO — hundreds of LOC) exists because `ctx` calls had to
  round-trip through the session DO. In an itx isolate, `itx.foo.bar()` is an
  in-process Workers RPC dispatch through the supervisor — no stream
  round-trip, audited at the registry. The whole protocol is dead weight.
- **`OrpcCapability`** literally walks the oRPC contract to expose it as
  `ctx.*` — the thing we're deleting, bridged into the thing we're deleting.
- **Sessions as DOs** (CodemodeSession, 1,343 LOC) hold provider state and
  pending calls. The itx processor needs almost no state: executions are
  events, capabilities live in the context registry.

What we keep: the event-sourced shape (request/completion as durable events on
a stream — that part was right), the executor isolate pattern (LOADER +
dynamic worker), and the agent feedback loop semantics.

## The itx processor

A class-model stream processor (same pattern as `ProjectLifecycleProcessor`,
project-durable-object.ts:253 and `CodemodeProcessor`):

**Contract** (`defineProcessorContract`, slug `itx`):

- consumes `itx/execution-requested`, emits `itx/execution-completed`
- state: in-flight executions by request offset (`requested` → `completed`) —
  the reduced state a dashboard view renders

**Implementation** (~150 LOC vs codemode's 3,847):

- `reduce()`: track execution status.
- `processEvent()` on `execution-requested`: `runInBackground` →
  load a one-off isolate via `LOADER` with
  `env.ITERATE = ItxEntrypoint({ props: { context } })` and
  `globalOutbound = ProjectEgress` (identical harness to `/api/itx/run`,
  fetch.ts:185-269 — reuse `itxRunWorkerSource`, lift it out of fetch.ts into
  the itx kernel so both call sites share it), run
  `({ itx, vars }) => …`, append `execution-completed` with
  `{ ok, result }` or `{ ok: false, error, stack }`.
- `context` in the event data defaults to the owning project's context;
  a `ctx_…` id targets a forked child context (agent sessions later get one
  context per session — fork-per-session is wired in a later step, the field
  exists from day one).

**Hosting**: on the **Project Durable Object's existing processor host**
(`host.add("itx", …)` next to `projectLifecycle`). One processor instance per
project, subscribed per-stream via the existing callable-subscription
machinery — no new DO class, no per-session DOs. If the host turns out to
need per-stream isolation for long executions, fall back to a tiny dedicated
DO; start without it.

**Execution guarantees**: same as codemode's posture — at-least-once dispatch
from the stream subscription; the completion event carries the request offset
so consumers correlate and dedupe. Long executions use `runInBackground` so
the checkpoint advances.

## Capabilities: the demo that matters

Providing a capability must be visibly easy, immediately:

1. The audit events **already exist** — `itx.caps.provide(...)` from a laptop
   appends `events.iterate.com/itx/cap-provided` to the project's `/itx`
   stream (registry → audit, DECISIONS D9).
2. Step 1 ships a demo flow proving the loop end-to-end: connect from a
   laptop (`connectItx`), `provide` a live cap (`runSwiftOnMyMac`-style),
   watch `cap-provided` land in the stream, then append an
   `execution-requested` whose script calls `itx.runSwiftOnMyMac(...)`, and
   watch `execution-completed` carry the answer. One e2e test + one
   README/docs snippet. This is the "look how easy" artifact.
3. Open design note: if we also want _event-driven_ capability registration
   (append a `cap-define-requested` event instead of calling
   `itx.caps.define`), that's a later nicety — the registry verbs already
   work from every execution mode, so step 1 doesn't need it.

## Rewiring the consumers of codemode

In dependency order; this is the bulk of the work.

### 1. Platform capabilities scripts actually use

Codemode scripts today reach `ctx.workspace`, `ctx.streams`, `ctx.fetch`,
`ctx.slack`, `ctx.secrets`, `ctx.gmail`, outbound MCP (exa/context7), repos,
AI. The itx handle already has `workspace`, `streams`, `repos`, `fetch`,
`worker`. Gaps to close so scripts keep their reach:

- **`slack`, `gmail`, `secrets`, `ai`, outbound-MCP**: expose the existing
  `*Capability` WorkerEntrypoints (slack-capability.ts, gmail, secrets,
  AiCapability, outbound-mcp-client) through the project context so scripts
  call `itx.slack.…`, `itx.secrets.…`. Mechanism: registry-registered
  platform caps wired at context init (the registry's `live` table pointing
  at loopback `ctx.exports` stubs — same wiring `ProjectCapability` does
  today), NOT new handle built-ins per domain. Typed via `ProjectCaps`
  declaration merging.
- Provider _instructions_ (the docs agents see) move from
  tool-provider-registration events to `meta.instructions` on the registered
  caps; `itx.caps.describe()` renders them.

### 2. The agent loop (agents + slack)

Today: agent-host extracts a script from LLM output →
`startCodemodeScriptOnExistingSession` → codemode appends
`script-execution-completed` → agent-host turns it into `input-added`
(agent-host/implementation.ts:147-228).

After: agent-host appends `itx/execution-requested` to the agent's stream →
itx processor executes → agent-host consumes `itx/execution-completed` →
`input-added`. The agent contract drops its consumption of codemode's
`tool-provider-registered` events; the agent system prompt is built from
`itx.caps.describe()` + a fixed paragraph documenting the handle built-ins.
`ensureCodemodeSession` (agent-durable-object.ts:460) and the slack
integration's session creation are deleted — there is no session to ensure;
the processor subscription on the agent stream replaces it.

### 3. MCP `exec_js`

Stays one tool, gets honest: input `{ code, project? }` where code is
`async ({ itx, vars }) => …`. Implementation: append `execution-requested` to
the MCP session's stream, `waitForEvent` for the matching
`execution-completed` (subscription.ts:55 already has waitForEvent), return
the payload. Tool description = the fixed built-ins paragraph +
`itx.caps.describe()` output. `CodemodeSessionBridge` and the provider-stack
plumbing in project-mcp-server-connection.ts die.

### 4. Dashboard

Delete the three codemode-sessions routes + `codemode-session-controls.tsx`.
Replacement in step 1 is deliberately minimal: the existing project stream
view already renders events; add renderers for the two itx event types
(requested → show the code; completed → show result/error) and a small
"run script" box on the stream page that appends `execution-requested` (via
the existing oRPC `streams.append` — the full react-on-itx layer is a later
step, we don't block on it). This _is_ the seed of the canonical
"filtered stream view".

### 5. oRPC surface (partial, codemode-only)

`orpc/routers/codemode.ts` (357 LOC) and the `project.codemode.*` contract
entries are deleted now — their replacement is appending events, not new
procedures. The rest of oRPC survives until the later cutover step. The CLI
keeps working (it discovers whatever the contract exposes).

### 6. Tests

- Port `codemode.e2e.test.ts` → `itx-processor.e2e.test.ts`: append
  execution-requested via stream append, assert completion event (and the
  cap-provided demo flow above).
- `codemode-mcp-provider-stack.e2e.test.ts` collapses to a small exec_js
  test (no provider stack to test).
- Delete `codemode-session.test.ts` (1,132 LOC), `codemode-builder.ts`.
- Agents e2e: assert the loop via the new events.

## Deletion list (step 1)

| Delete                                                                                                                                                        | Size          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `domains/codemode/` (all of it: session DO, processors, providers, examples)                                                                                  | ~3,847 LOC    |
| `orpc/routers/codemode.ts` + contract entries                                                                                                                 | ~400 LOC      |
| `routes/…/codemode-sessions/*` (3 routes) + controls component + lib helpers                                                                                  | ~600 LOC      |
| `rpc-targets/openapi-bridge.ts` + openapi-provider-registration                                                                                               | example cruft |
| `CodemodeSessionBridge` + provider stack in MCP connection DO                                                                                                 | ~200 LOC      |
| `ensureCodemodeSession` + codemode imports in agents/slack                                                                                                    | ~150 LOC      |
| `CODEMODE_SESSION` binding (alchemy.run.ts:113-116, worker env) + worker.ts exports (`OrpcCapability`, `AiCapability` as codemode providers, `OpenApiBridge`) | bindings      |
| `codemode-session.test.ts`, codemode e2e + builder                                                                                                            | ~1,700 LOC    |

New code: itx processor (~150), platform-cap wiring at context init (~150),
agent-host rewiring (~100), exec_js rewrite (~100), stream-view renderers +
run box (~150), e2e (~250). **Net: roughly −6,000 LOC.**

## Open questions (annotate here)

1. **Processor hosting**: Project DO host (recommended, zero new DOs) vs a
   dedicated per-stream DO if long executions on one stream shouldn't share a
   project-wide instance. Start on Project DO?
2. **Platform caps wiring**: registry `live` entries pointing at loopback
   entrypoint stubs, wired at Project DO init — happy with that mechanism, or
   should these be handle built-ins (`itx.slack` typed on the class)?
   Registry keeps the kernel closed; built-ins are better-typed but grow the
   handle per domain.
3. **AI surface**: codemode exposed `ctx.ai` (Workers AI). Keep as a platform
   cap (`itx.ai`) or drop until someone needs it?
4. **Execution timeouts**: codemode had none explicit; should
   execution-completed carry a `timed-out` outcome with a default budget
   (e.g. 60s) from day one? (Recommended: yes, cheap now.)

## Later steps (notes — each gets its own plan when it's up)

Detailed context for all of these: `itx-everywhere-plan.md`. Decisions already
made there: immediate-cutover posture (POC, no back-compat), one global WS per
tab, client-side stream filtering, no runtime validation layer (TS types are
the contract; form schemas live in form components), project-level authority
(DO surface audited — nothing crosses project boundaries), org-members-only
project creation, never capnweb HTTP-batch.

- **Step 2 — kernel + react**: reconnecting client core, `ItxError`,
  `getServerItx` (in-process SSR handle), browser stream subscriptions
  (`subscribe`/`subscribeState` bridging capnweb ↔ the Stream DO's existing
  subscribe RPC), then `<ItxProvider>` + subscription multiplexer + the two
  canonical components (`<ReducedStateView>`, `<StreamView>`) + thin query
  bridge. The step-1 stream renderers migrate onto `<StreamView>`.
- **Step 3 — surface parity**: typed facades for the remaining oRPC domains
  (secrets, integrations, hostnames, agents presets/messages, MCP sessions);
  org-membership `projects.create`.
- **Step 4 — the cutover**: convert all dashboard routes + e2e helpers + CLI
  (`cli itx run` / `cli itx call`) to itx; delete `apps/os/src/orpc/`,
  `apps/os-contract`, the API route files, `@orpc/*` deps; plain
  `/api/health`; doc sweep; worker.ts reads "authenticate → itx or app".
- **Step 5 — convergence niceties**: fork-per-agent-session child contexts,
  `caps.d.ts` generation from the registry, event-driven cap registration if
  still wanted, org contexts, hibernation when capnweb-in-DO lands upstream.
