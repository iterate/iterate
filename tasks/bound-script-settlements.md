---
status: in-progress
size: medium
---

# Bound script-result settlements (7MB settlement event bricked a prod stream)

**Status summary:** implemented, tests green (typecheck/lint/knip/format/targeted
tests pass locally). Oversized script results are now omitted at the settlement
boundary with preview + inferred type + guidance. Remaining: CI + review, and the
already-poisoned prod stream still needs unbricking (follow-up section).

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
metadata (`oversized: {kind: "omitted", serializedChars, preview, typeText}`) so the
model learns what happened and what the data looked like, and is told to write
large outputs to workspace files instead of returning them.

- [x] `packages/shared/src/script-execution.ts`: add optional `oversized` to
      the succeeded variant of `ScriptExecutionSettlement` _added as strictObject
      {kind: "omitted", serializedChars, preview, typeText}_
- [x] bounding function (capability-host, near `serializeScriptResult`): if
      compact-JSON length of `result` > `MAX_SCRIPT_RESULT_EVENT_CHARS` (1 MiB),
      replace with `oversized: {kind: "omitted"}`; also cap failure `error` text; idempotent
      _`boundScriptSettlement` in script-result-serialization.ts; error cap 32k_
- [x] apply in `ScriptExecutionEntrypoint.run` (so the blob never crosses RPC
      into the DO isolate) and in `scriptCompletionInput` (backstop for every
      other settlement source) _both sites wrap; rejected-outcome errors too_
- [x] `retainedScriptResult` + preamble render: new `omitted` row kind — the
      model sees size/type, no `.load` advertised (the data does not exist)
      _renders `{…, omitted: true}` with a size comment; contract schema variant
      added_
- [x] `renderScriptSettlement` (agent-codemode): render the omission honestly
      *before* the `result === undefined` turn-ends check, with preview +
      "write large data to workspace files" guidance _renders size vs limit,
      inferred type, preview fence, guidance_
- [x] `getScriptResult`: informative throw for omitted results (`load` path)
      _also `runCapabilityHostScript` throws instead of returning a silent null_
- [x] tests: oversized result → journaled event stays small, agent context gets
      the notice, preamble row is `omitted`, `getScriptResult` throws clearly
      _script-result-serialization.test.ts (bound unit), capability-host-preamble
      .test.ts (row + render + getScriptResult throw), agent-processor.test.ts
      (end-to-end omission render)_

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

- **Spill-at-settlement** (discussed 2026-09-02, parked deliberately — "valid
  snags", revisit before building): instead of dropping an oversized result,
  write it to the workspace at the settlement boundary and journal a pointer, so
  `load(itx)` / `workspace.getFile` keep working. Design notes from the
  discussion:
  - Keep `status: "succeeded"` and put the discrimination one level down
    (settled 2026-09-02: the shipped field is `oversized: {kind}` — the spill variant becomes `kind: "workspace-file"`, e.g. `oversized: { kind, serializedChars, preview, typeText, spilled?: {
    workspaceFile, format: "json" | "text" } }`) rather than a new top-level
    status arm — every consumer switching on `status === "succeeded"` stays a
    binary check, and the script genuinely did succeed.
  - Snag 1: settlements are journaled by the capability host, which serves
    scopes with no agent workspace (project REPL, Slack bang commands). Spill
    where a workspace exists (`/agents/**` scopes via
    `agentWorkspacePath` + `WORKSPACE_V2.writeFile`, same lane as the
    render-side spill), fall back to omission elsewhere.
  - Snag 2: the settlement append runs under a 15s grace window and a workspace
    write can wait on a first-use clone — so write-first-then-settle with a
    bounded wait, omission as the fallback when the write fails/times out
    (which is exactly what this PR's behavior already is).
  - `ScriptExecutionEntrypoint` can do the write itself (it has env +
    `{projectId, scopePath}` props, and `streamContext` carries the
    executionId), keeping the blob out of the DO isolate entirely; reuse the
    render-side `script-results/<sanitized executionId>.<ext>` naming so
    replays overwrite idempotently and the model sees one consistent place.
  - `getScriptResult` reads the pointer back (needs a `readWorkspaceFile` dep
    wired where `CapabilityHostProcessor` is constructed in
    processor-facet-durable-object.ts); the preamble row can then stay kind
    `large` (loadable) instead of `omitted`.
- Byte-budgeted `StreamEventLog.getRangeSized` (count-only paging is the read-side
  hazard; delivery's 1MiB cap applies only after materialization).
- Admin redaction for poison events already in logs — the bricked prod stream
  keeps its 7MB event; if it doesn't recover after this deploys, its chunks need
  redacting (or the stream erased).
- Consider a durable-append size cap with a loud error as a platform backstop.

## Implementation log

- 2026-09-02: diagnosed live in prod (see body above; itx probes + os-prd otel).
  Reproduced the OOM deterministically via `agents.get(...).processor.getRuntimeState()`.
- 2026-09-02: implemented. One deliberate extra beyond the spec:
  `runCapabilityHostScript` now throws for an omitted result instead of
  resolving `result: null` — a silent null would look like the script chose to
  return nothing. Failure `error` text cap is 32k chars (errors are context,
  not payload; state-side retention already truncates to 2k).
- Threshold constants live in `script-result-serialization.ts`:
  `MAX_SCRIPT_RESULT_EVENT_CHARS = 1 MiB`, `MAX_SCRIPT_ERROR_EVENT_CHARS = 32_000`.
