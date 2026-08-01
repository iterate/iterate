---
status: implemented
size: medium
---

# Deliver approval outcomes to the waiting agent; native code previews

## Status summary

**Redirected after review, then re-implemented; all gates green**
(typecheck/lint/knip/full unit suite, both mobile specs). The
approval-decision relay was built, then REMOVED on Misha's verdict — the
incident was a discarded 200, not a stranded decision (see "What changed
after review"). What ships now: progressive-enhancement code previews on
mobile (native text immediately, CodeMirror only on a positive ready
signal), two lines of prompt guidance against silent turns, and a new
placeholder task (tasks/agent-silent-turn-nudge.md) for the general
"turn ended with nothing visible" design. Remaining: PR review.

Two production bugs Misha hit on
device (prod project `misha`, thread `mobile/2026-08-01t03-30-40-828z`).

## What changed after review

Deeper diagnosis showed the script DID await the held fetch: it received the
released 200, discarded it, and returned undefined — silent settle by
contract, not a lost decision. Misha's verdict: held fetches must stay
completely opaque to scripts (normal fetches that happen to be slow), so
delivering approval decisions into the thread was the wrong fix and the
relay was removed (ordinary reverts, commits `392ab14`/`40bd71c`/`bda2d38`).
The no-response problem is really "agent turn ended with no sendMessage" —
a cross-channel design captured in tasks/agent-silent-turn-nudge.md. The
CodeBlock fix was also reworked from a plain-text swap into progressive
enhancement, and two terse prompt teaches were added (see checklist).

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

- ~~[x] Decision-outcome context appended to the originating agent thread~~
      — _built, then removed after review: the incident was a discarded 200,
      not a stranded decision; held fetches stay opaque to scripts. Reverted
      in `392ab14`/`40bd71c`/`bda2d38`_
- ~~[x] Unit test + egress e2e extension~~ — _reverted with the relay_
- [x] `CodeBlock` renders progressively (native text first, CodeMirror on
      ready) — _activity-card.tsx: monospace `<Text>` renders immediately;
      CodeEditor mounts invisibly behind it and swaps in only when its new
      `onReady` function prop fires from inside the webview (marshaled like
      `onChange`); modeled as a useMutation whose `mutate` IS the callback,
      swap derived from `.isSuccess`. Dev-only "editor webview never ready"
      badge after a 10s watchdog (a useQuery timer, `enabled: __DEV__`)_
- [x] Prompt guidance against silent turns — _agent-defaults.ts: summary
      instruction gains "never set waitingFor in a script that still awaits
      work"; prompt gains "do something visible with an awaited result".
      Budget ceiling 4100 → 4200, dated note in
      agent-prompt-budgets.test.ts_
- [x] Placeholder task for the general silent-turn nudge —
      _tasks/agent-silent-turn-nudge.md, `status: needs-grilling`_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene
      — _all green from the worktree root; mobile/approvals and
      mobile/notifications specs pass against local dev_

## Out of scope

- Teaching agents to await held fetches (model behavior, not protocol)
- Syntax highlighting for native previews
- Expiry pre-approve/retry flows (separate design task)

## Implementation log

### After the redirect (2026-08-01)

- Relay removed via three ordinary `git revert` commits (no history
  rewrite); reverts applied cleanly, projects-domain tests green after.
- Progressive CodeBlock: the ready signal is a new REQUIRED `onReady: () =>
  Promise<void>` prop on CodeEditor, fired at the end of its
  `componentDidMount` right after the `EditorView` is constructed — the same
  expo/dom function-prop marshaling `onChange` already uses (DOM-component
  function props must be async). repo.tsx passes an explicit noop (it has no
  fallback to swap from). In CodeBlock the callback is `useMutation`'s
  `mutate`; the swap derives from `.isSuccess` — no useState/useEffect. The
  container keeps the old height heuristic as a FIXED height so the
  text → editor swap can't jump; the hidden editor layer is absolute-fill,
  `opacity: 0`, `pointerEvents: "none"` until ready. The dev watchdog is a
  `useQuery` whose queryFn resolves after 10s (`enabled: __DEV__ &&
  !ready`), rendering a tiny red "editor webview never ready" badge.
- Prompt lines kept terse on purpose; the default-prompt ceiling had only
  ~156 chars of headroom, so it was raised 4100 → 4200 with the dated
  justification the budget file's own comments prescribe.

### Original implementation (superseded — relay since removed)

- Mechanism chosen: the per-event lane on the project processor itself, with
  `args.appendTo(streamContext.streamPath, ...)` — the same sibling-stream
  door the birth saga uses for `/scheduler/primary` etc. (all project
  streams share the DO). No new state fold: the decided event carries the
  batch offset, and `this.stream.getEvent({ offset })` reads the requested
  event from the processor's own stream — always committed, since it sits
  below the decided event's offset.
- The relay mirrors the door's acceptance policy via the existing pure
  helpers (`evaluateDecision` + `buildApprovalMessage`): verdict-count
  mismatch and unsigned/badly-signed approvals are ignored, so the agent is
  never told about a decision that released nothing. Keys come from the
  fold at the decided event's offset.
- Actor is `{ type: "integration", name: "egress-approvals" }` — the
  `stream-error` precedent: non-script, so `contextClearsWaitingFor` treats
  it as an external wake; demoted to user role at prompt time (decision
  data, not instructions).
- Idempotency: `this.idempotencyKey("approval-outcome", event)` — keyed on
  the decided event's offset per the spec (a second signed decision on the
  same batch would append a second, accurate, context item; the door
  ignores it, rare enough to accept).
- **Deviation**: batches from slash-command runs (`executionId` prefix
  `slash-command:`) get `llmRequestPolicy: dont-trigger-request`. Found by
  the mobile approvals spec's headline "zero model turns" assertion: a
  `/script` run is user-driven with no parked agent, so waking the model on
  its decision is pure chatter. Agent-initiated runs keep
  `after-current-request` — the strand fix proper.
- Known-flaky, pre-existing, unrelated: the "approved worker WebSocket
  egress" e2e fails on this machine's local dev servers ("WebSocket echo
  failed") — same failure documented at the merge base in
  tasks/complete/2026-07-28-grouped-approvals.md. All other egress e2e
  tests pass, including the extended burst test.
- The local dev server intermittently wedges into an unhealthy "fetch
  failed" loop after heavy e2e runs and needs `pnpm dev restart --detach`
  (machine-local; also pre-existing).
