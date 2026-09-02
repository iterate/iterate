---
status: in-progress
size: medium
---

# Bound script-result settlements (7MB settlement event bricked a prod stream)

**Status summary:** diagnosed; implementation not started. Fix = cap the serialized
script result at the settlement-journaling boundary; oversized results are omitted
from the event with an honest preview + inferred type + guidance.

## What happened (prod, 2026-09-02)

`prj_…misha` stream `/agents/web/2026-09-02t08-30-16-937z` ("Crop Numberblocks lab"):
a codemode script ran an image-crop in the sandbox and its `stdout` came back as a
7MB base64 PNG. The whole blob was journaled verbatim as one
`capability-host/script-run-settled` event (offset 2381, 7,051KB — there is no size
guard anywhere between the dynamic worker's return value and the durable append).

That one event then fans out to every fold/delivery lane in the *same isolate*
(agent facet, capability-host facet, subscriber deliveries, posthog capture, parent
streams — facets and colocated DOs share the 128MiB heap), each materializing 3–4
copies via decode → JSON.parse → zod → render. Result: "Durable Object's isolate
exceeded its memory limit and was reset", then the keepalive's mark-before-work →
OOM → revival loop appends `stream/woken` every ~5s indefinitely (~170 so far; the
backoff resets after quiet). The stream UI shows the OOM error and the agent is
bricked. `getRuntimeState()` on the agent reproduces the OOM deterministically.

Evidence: os-prd otel traceIds `2f4ac441f25d6160d83109e1a2f44013`,
`78d9c657c44d0719061fdc9da01227c9` (11:37Z OOMs); same signature on 2026-08-31
21:25–22:05Z (DO `9df94945…`, different stream). The same stream also carries a
1,059KB settlement at offset 208 which survived — the hazard scales with size.

## Fix

Bound every settlement at the two journaling choke points. Over the limit, the
result is **omitted, not truncated-in-place**: the event carries structured
metadata (`resultOmitted: {reason, serializedBytes, preview, typeText}`) so the
model learns what happened and what the data looked like, and is told to write
large outputs to workspace files instead of returning them.

- [ ] `packages/shared/src/script-execution.ts`: add optional `resultOmitted` to
      the succeeded variant of `ScriptExecutionSettlement`
- [ ] bounding function (capability-host, near `serializeScriptResult`): if
      compact-JSON length of `result` > `MAX_SCRIPT_RESULT_EVENT_BYTES` (1 MiB),
      replace with `resultOmitted`; also cap failure `error` text; idempotent
- [ ] apply in `ScriptExecutionEntrypoint.run` (so the blob never crosses RPC
      into the DO isolate) and in `scriptCompletionInput` (backstop for every
      other settlement source)
- [ ] `retainedScriptResult` + preamble render: new `omitted` row kind — the
      model sees size/type, no `.load` advertised (the data does not exist)
- [ ] `renderScriptSettlement` (agent-codemode): render the omission honestly
      *before* the `result === undefined` turn-ends check, with preview +
      "write large data to workspace files" guidance
- [ ] `getScriptResult`: informative throw for omitted results (`load` path)
- [ ] tests: oversized result → journaled event stays small, agent context gets
      the notice, preamble row is `omitted`, `getScriptResult` throws clearly

## Assumptions made (Misha AFK)

- 1 MiB limit: the 7MB event bricked; a ~1MB one survived. Fan-out amplification
  is roughly 15–20×, so 1 MiB keeps worst-case transient cost ~20MB. Easy to tune,
  single constant.
- Omission over spill-to-R2: keeping `load()` working for oversized results means
  a new storage + GC surface. Not tonight; the workspace-file spill already exists
  agent-side for the model to use deliberately. Noted as possible follow-up.
- No append-size hard cap in StreamDurableObject in this PR: other producers may
  legitimately append >1MiB today; a blanket cap needs its own audit. Follow-up.

## Follow-ups (not this PR)

- Byte-budgeted `StreamEventLog.getRangeSized` (count-only paging is the read-side
  hazard; delivery's 1MiB cap applies only after materialization).
- Admin redaction for poison events already in logs — the bricked prod stream
  keeps its 7MB event; if it doesn't recover after this deploys, its chunks need
  redacting (or the stream erased).
- Consider a durable-append size cap with a loud error as a platform backstop.

## Implementation log
