---
state: in-progress
priority: high
size: large
dependsOn: []
tags: [os, itx, codemode, agents]
---

# Kill codemode, birth the itx processor

Being executed as its own effort (agent already working on it); recorded here
so the plan survives the session. Context:
[itx oRPC replacement plan](../apps/os/docs/itx-orpc-replacement-plan.md).

Codemode — the `ctx`-based script execution system (~3,850 LOC domain +
session DO) — is deleted entirely and replaced by a **very limited stream
processor**, the **itx processor**. Two events drive it:

```text
events.iterate.com/itx/execution-requested    { functionSource, vars?, context? }
events.iterate.com/itx/execution-completed    { requestOffset, ok, result | error }
```

Append `execution-requested` to a stream; the processor runs the code against
an itx handle (loader isolate, `env.ITERATE`, ProjectEgress as global fetch —
the `/api/itx/run` harness, lifted into the kernel for reuse); the result
returns as `execution-completed`. **No `ctx` left anywhere** — scripts receive
`{ itx, vars }` like every other itx execution mode. Event names join the
existing `events.iterate.com/itx/*` audit family, so one stream view tells the
whole story: capabilities appearing, executions running, results landing.

## Why deletion, not evolution

- The `ctx` provider model is a parallel capability registry — the itx
  registry replaces it (one dispatch).
- The `function-call-requested/completed` stream protocol exists only because
  `ctx` calls round-tripped through the session DO; in an itx isolate,
  `itx.foo.bar()` is an in-process dispatch through the supervisor.
- `OrpcCapability` walks the oRPC contract — the thing being deleted, bridged
  into the thing being deleted.
- Sessions-as-DOs hold provider state and pending calls; the processor needs
  almost none: executions are events, capabilities live in the registry.

## Checklist

- [ ] Processor (contract slug `itx`, ~150 LOC): `reduce` tracks executions;
      `processEvent` on `execution-requested` → `runInBackground` → loader
      isolate → append `execution-completed`. Hosted on the Project DO's
      processor host (`host.add("itx", …)` next to `projectLifecycle`).
      `context` field defaults to the project context; `ctx_…` targets a
      fork. Default execution timeout with a `timed-out` outcome.
- [ ] Platform caps scripts need (`slack`, `gmail`, `secrets`, `ai`,
      outbound-MCP): registry-registered at context init pointing at the
      existing `*Capability` loopback entrypoints; instructions move to
      `meta.instructions`; typed via `ProjectCaps` merging.
- [ ] Agent loop: agent-host appends `execution-requested` / consumes
      `execution-completed` → `input-added`; system prompt built from
      `itx.caps.describe()`; `ensureCodemodeSession` and slack session
      creation deleted.
- [ ] MCP `exec_js` → append + `waitForEvent`, code is
      `async ({ itx, vars }) => …`; provider-stack plumbing dies.
- [ ] Dashboard: codemode-sessions routes deleted; stream views render the
      two itx event types.
- [ ] Delete: `domains/codemode/`, `orpc/routers/codemode.ts` + contract
      entries, `CODEMODE_SESSION` binding, `OrpcCapability`/`OpenApiBridge`
      exports, codemode tests (~1,700 LOC); port
      `codemode.e2e.test.ts` → `itx-processor.e2e.test.ts`.
- [ ] The "look how easy" capability demo: laptop `connectItx` →
      `caps.provide` → `cap-provided` lands in the stream → an
      `execution-requested` script calls the cap → `execution-completed`
      carries the answer. One e2e + one docs snippet.

## Acceptance

- `grep -r codemode apps/os/src` returns nothing; net ≈ −6,000 LOC.
- Agents and MCP exec work through the itx processor events end-to-end on a
  preview.
