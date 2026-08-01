---
status: ready
size: medium
---

# Deliver approval outcomes to the waiting agent; native code previews

## Status summary

Spec committed, implementation not started. Two production bugs Misha hit on
device (prod project `misha`, thread `mobile/2026-08-01t03-30-40-828z`).

## Bug 1: after approving, nothing happened and the agent got confused

Prod evidence (root stream offsets 1384–1392, agent stream 1085–1098):

- The agent's script fired a Gmail GET that parked at the egress door
  (`human-approval-requested` 1384), then messaged "please approve", set
  `waitingFor: external_event`, and **returned** — `script-run-settled
  succeeded` landed BEFORE any decision. The script did not await the held
  fetch.
- Misha approved: `approval-presented` 1387 (suppression claim — worked),
  `human-approval-decided` approve, signed, 1389, `human-approval-settled`
  status 200 at 1392. The released fetch succeeded.
- **No event ever landed on the agent stream after the decision.** The 200
  went nowhere (its awaiter was gone), the agent's `waitingFor:
  external_event` never cleared, and the human's next message met an agent
  with no idea the approval happened.

The gap: there is no delivery path from an approval decision back to the
originating agent thread. The happy path (script awaits the held fetch)
masks it; any script that returns before deciding — model's choice, timeout,
crash — strands the thread.

### Fix

When a `human-approval-decided` lands for a batch whose `streamContext` is a
script-execution on an `/agents/…` stream, append a compact developer-role
context item to that agent stream: rule key, per-request verdicts,
rejection reason if present, and the request summaries (method + host). Use
`llmRequestPolicy: { behaviour: "after-current-request" }` so it wakes a
parked agent (developer + non-script actor clears `waitingFor`), and rides
after the settle render when the script is still running (mildly redundant
there, harmless — a human decision is context worth having in the thread
either way).

Mechanism is the implementer's choice; constraints and leads:

- The decided event carries only `approvalRequestEventOffset` — the
  requested event (which holds `streamContext` and `requests`) must be
  looked up. Options: fetch it from the project stream in the per-event lane
  (processors can read their own stream), or have the project processor's
  reduce retain open batches (check what state it already folds for
  approvals before adding anything).
- Cross-stream append (project root → agent stream): find the existing
  precedent for appending to a sibling stream inside the project DO (all
  project streams live in the same DO; the notification processor and the
  device subscription mechanics are nearby prior art — pick what fits,
  don't invent a new lane kind if one exists).
- Expiry decisions (`decidedBy: "expiry"`) should get the same treatment —
  an expired batch is exactly the woke-up-too-late case where the agent
  needs to know.
- Idempotency-key the append on the decided event's offset.

### Tests

- Project-processor (or wherever the lane lands) unit test: decided event
  for an agent-thread batch → context appended to the agent stream with the
  right body/policy; scope-hold batch → no append.
- Extend `apps/os/e2e/vitest/egress-approvals.e2e.test.ts`: after the
  decision releases the burst, assert the agent stream received the decision
  context (this also covers the strand scenario end to end).

## Bug 2: blank code previews in the mobile activity feed

`CodeBlock` (apps/mobile/src/components/activity-card.tsx) renders every
read-only code/result preview through `CodeEditor` — a `"use dom"` Expo DOM
component, i.e. one **webview per code block**. On Misha's device every
preview rendered blank (fixed-height empty box). Whatever the proximate
loader failure (remote dev-client over tailscale is suspect), a webview per
feed row is the wrong tool for read-only text: heavy, async, and it fails
closed to an empty box.

### Fix

Render read-only previews natively: `CodeBlock` becomes a monospace
`<Text>` (selectable, existing height heuristic, horizontal scroll if
needed) — no webview involved, cannot be blank. The full `CodeEditor` stays
for the actual editing surface (repo workspace). No syntax highlighting in
v1 — reliability over color; note it as a possible follow-up.

### Tests

- Existing mobile unit/spec suites must stay green; if the approvals/
  notifications specs assert on code text visibility, they now exercise the
  native path implicitly.

## Checklist

- [ ] Decision-outcome context appended to the originating agent thread
      (human and expiry decisions; scope holds unaffected)
- [ ] Unit test + egress e2e extension
- [ ] `CodeBlock` renders natively (webview only used for editing surfaces)
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Teaching agents to await held fetches (model behavior, not protocol)
- Syntax highlighting for native previews
- Expiry pre-approve/retry flows (separate design task)
