# Interview log: grouped-approvals

Topic: group egress approval requests by originating script run (`streamContext.executionId`), so one script run with N held requests yields one coherent approval decision surface + one push, instead of N.

Interviewer: main-session Claude answering on Misha's behalf (guesses tagged `[guess: ...]`).
Interviewee: sub-claude (sonnet) running grill-with-docs against the dossier. Session `9b9da07f-cb68-4ac1-8e30-34e0d7488896`.

---

## Q1 — when does the one collapsed notification fire? — 2026-07-24

Sub-claude investigated the gate and notification processor. Key finding: N `human-approval-requested` events land in quick succession with no "last one" marker, and waiting for `script-run-settled` would deadlock (the script can't settle until its held fetches resolve). Recommends: per-`executionId` debounce window in the notification layer, modeled on `SchedulerProcessor`'s alarm-from-reduced-state pattern — 3s window extended by each subsequent hold, capped at ~10s, then one summarizing `notification/requested`. Non-script scopes keep today's immediate per-request pushes. Rejected APNs `thread-id` grouping (collapses presentation, not volume — still N buzzes).

## A1

Accepted: debounce-window-then-one-push, alarm-from-reduced-state, no new DO. 3s/10s accepted `[guess: exact numbers are taste; a Promise.all burst hits the gate within ~a second — make them tunable constants]`. Locked in: (1) late arrivals after a fired window start a NEW window and a NEW push — drip-feeding scripts must not go silent; idempotency key incorporates first held offset in window, not just executionId. (2) Push body leads with counts by host ("Script run waiting: 12 requests (12x gmail.googleapis.com)"), host-only lock-screen privacy as today, deep link to the group. Ungrouped scope unchanged.

---

## Q2 — how many Face ID prompts does "approve all N" cost? — 2026-07-24

Sub-claude found `signWithApproverKey` (`apps/mobile/src/lib/approver.ts:60-73`) calls `SecureStore.getItemAsync(..., { requireAuthentication: true })` per call → looping it for 12 grants = 12 Face ID prompts. Recommends `signManyWithApproverKey(projectId, messages[])`: ONE authenticated key retrieval, loop N signatures in memory (@noble/curves), drop the key — still N per-request signatures and N `human-approval-granted` events. Asks: all-or-nothing vs best-effort batch?

## A2

Yes to `signManyWithApproverKey`. Best-effort — and it's not really a choice: grants land on an event stream, so once one is appended there is no rollback. Sign all N in memory first, then append grants one by one; on mid-batch append failure the appended grants stand and the UI keeps the remainder visibly pending with retry. One-unlock-covers-N to be confirmed on-device in Phase 3 `[guess: requireAuthentication gates the retrieval; we retrieve once, signing after is pure JS]`.

---

## Q3 — how does the mobile list render a group? — 2026-07-24

Proposal: bucket the FlatList by `executionId` (script-execution scope only). Singletons render exactly as today. 2+ open requests → collapsed header with pending count + host breakdown + Approve all / Reject all right on the header; expanding reveals individual ApprovalCards (per-request escape hatch: "approve 11, reject 1"). Header count = pending count only. Live stragglers appear in place (grouping re-derived per render from live events). New push destination kind `approvals-group` carrying `executionId` (globally unique). Asks: approve-all straight from collapsed header, or force expand as confirm step?

## A3

Approve-all from the collapsed header — the Face ID sheet IS the confirm step. Refinements: (1) header must justify one-tap approve-all: count, host breakdown, rule description(s), and a peek at the originating script via existing `scriptCodeForApproval` `[guess: the script is the real trust signal; the 50 requests are usually homogeneous]`. (2) Group sorts by oldest pending member. (3) In-flight batch: disable buttons, show partial progress ("granting 3/12…") — no lying spinner. (4) Singletons as today. (5) Old `approvals` destination kind keeps working.

---

## Q4 — where does the debounce state machine live? — 2026-07-24

`NotificationProcessor` is deliberately stateless-per-event and only consumes `notification/created` + `human-approval-requested`. The design needs it to consume granted/rejected/settled, hold per-executionId reduced state, and schedule alarms. Recommends: keep it on NotificationProcessor (its whole job is "which facts deserve a notification"), document the exception explicitly rather than silently reinterpret "stateless".

## A4

Agreed — one component owns notification-worthiness. Conditions: (1) update the class doc honestly ("stateless per event EXCEPT the grouped-approval debounce"), follow docs/writing-stream-processors.md patterns (obligation pattern, SchedulerProcessor-style alarms). (2) Bound the state: prune an executionId entry once all held offsets are resolved and its window has fired `[guess: pruning on all-resolved-or-expired suffices; no separate GC sweep]`.

---

## Q5 — is the menubar app's own local-notification flood in scope? — 2026-07-24

Sub-claude found `Iterate.swift:320-344` fires one native macOS banner per held request, driven by watching the stream directly — independent of the server notification pipeline. 50-request burst = 50 banners today. Recommends: defer explicitly as named follow-up (different language/process, no shared code, separable).

## A5

Agreed — named follow-up with pointer to `Iterate.swift:320-344`. In scope: verify (not change) that CLI/menubar don't break on a grouped burst, since the per-request event vocabulary is unchanged `[guess: zero code changes needed there, verification only]`.

---

## Q6 — alarm fire-time loose ends — 2026-07-24

(a) Suppress-if-empty: if every hold resolves before the alarm fires (user live-tailing the screen), skip the push; alarm still prunes state. (b) Testability: window-close handler must be a plain function driven directly by unit tests with controlled offsets/fake time (like `scheduler-processor.test.ts`'s `triggerDue()`), no real 3-10s sleeps; at most one real-time e2e smoke.

## A6

Agree with both. (b) is a hard requirement, not a preference — slow feedback loops are a disaster (docs/testing.md discipline). Steered: remaining branches are (1) summary computation client vs server, (2) the phone demo recipe, (3) deep-link contract migration.

---

## Q7 — remaining branches — 2026-07-24

(3) Deep-link migration: non-issue, `destination` is a discriminated union, adding `approvals-group` is additive. (1) Two independent computations: push body text computed server-side at alarm-fire time from processor state; mobile group header computed client-side live from raw events (extend `deriveOpenRequests` to bucket by executionId). Subtlety: should the processor's pending set be the FULL currently-open set for the execution (straggler push says "3 still waiting" including earlier-window members) or only-new-since-last-push? (2) Demo recipe: hold rule on a disposable echo host + `pnpm cli itx run` script doing Promise.all of ~12 POSTs; asks fake host vs real Gmail.

## A7

(1) Full currently-open set, definitively — the push is a statement about the world, not a changelog. (3) Agreed non-issue. (2) Fake echo host, never Gmail (no live Google dependency, no real-email risk). Topology correction: egress fetch happens from the project DO on the laptop, so the echo host only needs laptop reachability (localhost fine); the phone needs metro + the OS dev server API over tailscale (captun as fallback). Exact phone steps go in the PR body, written for Misha personally (phone already on tailnet, dev client installed). Demo must trigger a real push: notification → deep link → group → approve-all end to end.

---

## Q8 — termination — 2026-07-24

Sub-claude: every branch resolved; recorded **Approval Group** in `apps/os/CONTEXT.md` and the debounce-vs-APNs-threading-vs-batch-signatures trade-off in `apps/os/docs/adr/0006-debounced-notification-processor-for-approval-groups.md`. **Ready for Phase 2.**
