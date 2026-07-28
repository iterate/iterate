---
status: implemented (v2)
size: large
---

# Group egress approvals by script run → approvals ARE batches (v2)

## Status summary

v1 (computed Approval Groups over per-request events) was implemented and confirmed on-device, then Misha redirected during PR review: make the batch the ONLY shape — an approval request carries a `requests` array, a singular approval is an array of length 1, and the group concept disappears entirely. Non-backwards-compatible by design ("no real users right now", no legacy parsing). v2 is now IMPLEMENTED on this same branch/PR (#2309): typecheck/lint/knip/unit tests green across the repo, egress e2e passing against a live local dev server (burst → ONE batch event → ONE push → ONE decision releases all; mixed verdicts; signed decisions; only the WebSocket-egress lane fails locally, the KNOWN pre-existing laptop-env issue), mobile approver e2e 5/5 live. Remaining: fresh on-device phone trial of the v2 UI (JS-only change — metro reload suffices). The v1 sections below are kept as history.

## v2 design (approved by Misha, 2026-07-26)

Batching moves UPSTREAM into the egress door (the dataloader), and the notification layer goes back to stateless. One request event per burst, one signed decision event per verdict set.

### Events (breaking rewrite, same type names where shapes allow)

- `human-approval-requested`: payload becomes `{requests: [{method, url, headers, body?, secretPaths}], ruleKey, ruleDescription, streamContext?, expiresAt}` — the per-request fields move into the `requests` array (min 1); rule/provenance/expiry are batch-level because a batch never spans rules or executions.
- `human-approval-decided` REPLACES `human-approval-granted` + `human-approval-rejected`: `{approvalRequestEventOffset, verdicts: ("approve"|"reject")[], decidedBy: "human"|"expiry", keyId?, signature?}`. One event, one signature, mixed verdicts allowed. `decidedBy: "expiry"` is the door's own auto-reject (all verdicts "reject", never signed). First decided event at the batch's offset wins; later ones are ignored.
- `human-approval-settled` stays per released request: `{approvalRequestEventOffset, index, status?/error?}` — approval and outcome remain separate facts, and upstream fetches finish at different times.

### approval.v2 canonical message

`{v: "approval.v2", projectId, approvalRequestEventOffset, requests: [{method, url, headers, bodySha256, secretPaths}], verdicts}` — one ECDSA P-256 signature covers the whole decision. Signature policy (evaluateDecision): all-reject decisions are always accepted unsigned (deny stays fail-safe); once any active key is enrolled, a decision containing any "approve" verdict must carry a valid signature from an active key or the WHOLE event is ignored (a bad decision never kills a hold). Malformed (verdict count ≠ request count) → ignored.

### Egress door dataloader (project-durable-object.ts)

- Hold rules gain `debounceMs: number|null` (default **100**; cap = 3×debounceMs; `null` disables batching). 100 is enough because debounce can only ever catch CONCURRENT requests — a sequential loop's next fetch starts only after the previous one resolves, which requires approval — and simultaneous bursts land within milliseconds.
- Pending batches are in-memory per (executionId, ruleKey), only for holds with script-execution provenance; scope holds and `debounceMs: null` flush immediately as singletons. First arrival opens the batch and schedules the flush; each arrival extends by debounceMs, capped. Flush: stamp the deadline, append ONE requested event, park every caller on one shared resolution waiter. DO death pre-flush kills the queued fetches with the DO — nothing recorded, nothing stranded.
- On decision: approve-indexes release through the egress lanes concurrently, each appending its own settled event; reject-indexes return 403 `approval_rejected`; expiry appends the decided event (`decidedBy: "expiry"`, idempotency-keyed) and returns 403 `approval_expired`.

### What gets DELETED

The ADR 0006 debounce state machine (NotificationProcessor returns to stateless one-event-one-push, `approvalGroups` state gone, DO alarm slice + `fireDueApprovalGroupWindows` gone), the `approvals-group` destination kind (one `approvals` kind pointing at the batch event offset), mobile's `groupOpenRequests`/`groupResolvedRequests`/`grantMany`/`rejectMany`/`signManyWithApproverKey` (one decision = one signature = one append — the best-effort sequential append loop dies), and the granted/rejected event vocabulary everywhere (CLI, menubar NDJSON, mobile, e2e).

### v2 checklist

- [x] Contract: requested payload → `requests[]`; `human-approval-decided`; settled gains `index`; egress rule `debounceMs` _project-processor-contract.ts; granted/rejected schemas deleted; `HeldRequest` type exported_
- [x] Pure half: `buildApprovalMessage` v2 (requests+verdicts), `evaluateDecision` replacing `evaluateGrant` _egress-approvals.ts; all-reject always accepted unsigned; unit tests rewritten incl. order-is-identity and mixed-verdict cases_
- [x] Egress door: pending-batch dataloader, one requested append per flush, shared decision waiter, per-index release/settle, expiry decided event _project-durable-object.ts `#pendingHoldBatches`/`#flushHoldBatch`/`#awaitBatchDecision`/`#judgeDecision`; in-memory Map + timers keyed (executionId, ruleKey); cap = 3x debounceMs_
- [x] NotificationProcessor: stateless again — one intent per requested event (singular body unchanged, batch body "Script run waiting: N requests (Nx host)"), destination always `{kind: "approvals", approvalRequestEventOffset}`; delete state machine + DO alarm slice _implementation + contract rewritten; DO alarm() back to registry-only_
- [x] Intent contract: drop `approvals-group` destination kind _notification-intent-contract.ts; itx-api regenerated_
- [x] CLI approver: approve-core/approve/approve-json reshaped (decide-with-verdicts, batch rows keyed by offset, per-index settlement readback) _decide()/summarizeRequests(); NDJSON rows carry requests[]+summary+count, stdin decisions now approve|reject; awaitSettlement waits for every approved index and surfaces the door's expiry decision_
- [x] Menubar Swift: render batch rows (count + summary), decisions unchanged `{offset, decision}` _Iterate.swift HeldRequest → {summary,count}; Approve all N / Reject all buttons; enclave-approver.swift dialog lists the batch and signs once_
- [x] Mobile: approvals lib derives open/resolved BATCHES; decide() single signature; screen renders one card per batch (singleton = today's card, N>1 = group-style card with Approve all/Reject all); recents mirror; routing loses `approvals-group` _approvals.ts rewritten (OpenBatch/ResolvedBatch/indexApprovalEvents); approver.ts back to signWithApproverKey only; approvals.tsx BatchCard + RequestDetails; notification-routing.ts simplified_
- [x] Tests: egress-approvals unit, notification-processor (stateless), device-processor, project-processor, mobile approvals/routing, approve-core, e2e egress-approvals (burst → ONE requested event with 4 requests → one decided releases all), mobile e2e roundtrip _all rewritten; new mixed-verdicts e2e lane; e2e verified against a live local dev server (6/7 — WebSocket lane is the pre-existing local-env failure); mobile e2e 5/5 live_
- [x] ~~Scripts: `demo-grouped-approvals.ts` → `approvals.ts` exporting `demoGrouping` (`pnpm cli approvals demo-grouping`); examples entry text updated~~ _CLI wrapper deleted per review — the catalogue example's Run buttons in apps/os and apps/mobile are the demo surface; no laptop CLI needed_
- [x] Docs: ADR 0007 records the batch design; CONTEXT.md Approval Group term replaced by the batch-shaped approval _adr/0007-approval-batches-at-the-egress-door.md, self-contained; the superseded 0006 ADR was deleted per review rather than merged pre-superseded (its content survives as 0007's "first design" paragraph); CONTEXT.md term is now **Approval Batch** (ambiguity log notes the reversal)_
- [x] Regenerate itx-api generated files if schemas leak into them _generate:itx-api + generate:itx-examples_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; push; update PR body; resolve the three review threads _all green locally; PR body + threads handled post-push_

### Follow-up (post-merge, first thing): rejection reasons

Reject in the app prompts for an optional free-text reason; it rides the decided event's verdicts (`{verdict: "reject", reason}` — needs verdicts to become objects, or a parallel `reasons` array decided at implementation time); the door settles rejected indexes with a synthetic 403 whose JSON body carries `{deniedBy: "human", reason}` + an `x-iterate-egress-denied` header, so the script's error output contains the reason verbatim and the calling agent can decide whether to retry differently.

---

# v1 history (superseded by the v2 rewrite above)

Implemented end to end; PR #2309. Server: NotificationProcessor debounces script-scoped holds into one `approvals-group` push per window (unit-tested with virtual time, plus one real-time e2e smoke that passed against a live dev server). Mobile: grouped cards with Approve-all behind one Face ID, batch progress, deep link. Demo: itx catalogue example **"Grouped approvals demo: a 12-request burst, ONE push"** — runnable from the phone's Examples screen against ANY deployment (hits dummy-petshop.iterate.com; the CLI wrapper `pnpm cli demo-grouped-approvals run` executes the same entry). Verified end to end against a live dev server: burst → one grouped push intent → grant-all → 200s. On-device phone trial CONFIRMED (see bottom).

## Problem

Enabling a `hold` egress rule (e.g. gmail) floods the approver: a script run doing `Promise.all` over ~50 requests produces ~50 approval requests, ~50 pushes, ~50 taps + Face ID prompts. Every held request already carries `streamContext.executionId` identifying its script run (`project-durable-object.ts:424`); nothing groups on it.

## Design (decided — see interview for reasoning)

**Approval Group** (term now in `apps/os/CONTEXT.md`): the set of held requests sharing one Script Execution's `executionId`. Not a persisted entity — a grouping computed over `human-approval-requested` events. Per-request grant/reject events remain the unit of record; a group is never signed or decided as a single unit (the since-deleted ADR 0006 — superseded by 0007 before ever reaching main).

- **Notifications**: NotificationProcessor gains a small explicit per-`executionId` state machine (documented exception to its stateless-per-event rule): debounce window opens on first hold (3s, extended per hold, 10s cap — tunable constants), alarm-from-reduced-state like SchedulerProcessor. At fire time: one `notification/requested` summarizing the FULL currently-open set ("Script run waiting: 12 requests (12x gmail.googleapis.com)" — host-only privacy), deep-linking via new additive `destination.kind: "approvals-group"` `{executionId}`. Zero pending at fire time → no push, still prune. Holds landing after a fired window start a new window/push (idempotency key includes first held offset of the window). Non-script scopes: today's immediate per-request behavior, untouched.
- **Mobile UI** (`apps/mobile/.../approvals.tsx`): bucket open requests by executionId. Singletons render exactly as today. 2+ pending → collapsed header (pending count, host breakdown, rule descriptions, view-script affordance via existing `scriptCodeForApproval`) with Approve all / Reject all on the header; expand for per-request cards (approve 11, reject 1). Group sorts by oldest pending member. In-flight batch shows partial progress ("granting 3/12…"), buttons disabled.
- **Signing**: new `signManyWithApproverKey(projectId, messages[])` — ONE authenticated SecureStore retrieval (one Face ID), N in-memory signatures, N ordinary grant events. Best-effort appends: no rollback possible on a stream; failures leave the remainder visibly pending with retry.
- **State bounding**: prune an executionId entry when all members resolved/expired and its window fired.

## Checklist

- [x] NotificationProcessor: consume `human-approval-granted/rejected/settled`; per-executionId reduced state `{windowOpensAt, heldOffsets[], notifiedThroughOffset}`; alarm scheduling; window-close handler as a plain unit-testable function (no real sleeps — hard requirement) _`approvalGroups` in `notification-processor-contract.ts` (members record carries per-offset host/ruleKey/resolved); `fireDueApprovalGroupWindows()` + pure helpers (`approvalGroupFireAtMs`, `nextApprovalGroupWakeAtMs`, `approvalGroupPushBody`) in `notification-processor-implementation.ts`; project DO arms a "notification" alarm slice and calls the fire handler from `alarm()`_
- [x] Group push intent: summary body (counts by host), `approvals-group` destination kind (additive union member), idempotency key `notification/approval-group@<executionId>:<firstWindowOffset>` _destination union member in `notification-intent-contract.ts`; itx-api regenerated_
- [x] Suppress-if-empty at fire time + state pruning _fire handler skips empty open sets; reduce prunes an entry once every member is resolved-or-expired (per the reducing event's createdAt — pure fold), which also covers all-resolved-before-fire; past-due unclosable windows re-check on a bounded cadence instead of hot-looping_
- [x] Mobile: bucket by executionId in `deriveOpenRequests` (or alongside), grouped header UI, expand/collapse, per-request escape hatch _`groupOpenRequests`/`groupHostBreakdown` in `apps/mobile/src/lib/approvals.ts`; `ApprovalGroupCard` in `approvals.tsx` (header count = pending only, expand renders individual `ApprovalCard`s, singletons unchanged)_
- [x] Mobile: `signManyWithApproverKey` in `approver.ts` / `approver-core.ts`; best-effort append loop with progress + retry-pending UI _one authenticated Keychain read → N @noble signatures (`approver.ts`; `signWithApproverKey` now delegates); `grantMany`/`rejectMany` append sequentially with progress; the group header shows "granting 3/12…" from a query-cache progress entry_
- [x] Mobile: route `approvals-group` deep link → expand + highlight group; keep `approvals` kind working _`notification-routing.ts` maps `{kind: "approvals-group", executionId}` → approvals screen `approvalGroupExecutionId` param; the screen floats/expands/highlights that group; `approvals` untouched_
- [x] Unit tests: window open/extend/cap, late-arrival new window, suppress-if-empty, pruning, full-open-set counting across windows _7 new specs in `notification-processor.test.ts`, all on the virtual-clock harness with direct fire calls (plus crashed-wake observe-and-skip and independent concurrent executions)_
- [x] e2e: at most one real-time smoke of a grouped burst (extend `egress-approvals.e2e.test.ts` pattern) _one smoke: 4-POST burst → one `approvals-group` intent one debounce window later, grants release the script; passed against a live local dev server_
- [x] Demo recipe: hold rule on disposable echo host + itx script doing `Promise.all` of ~12 POSTs; PR body gets phone-trial instructions (metro + OS dev server over tailscale; captun fallback) _`apps/os/scripts/demo-grouped-approvals.ts`, registered as `pnpm cli demo-grouped-approvals run`; commands below_
- [x] Verify (not change) CLI `iterate approve` and menubar behave sanely on a grouped burst _verified by inspection: `approve-core.ts:191` watches only the four `human-approval-*` types (never notification intents), so a burst is just N ordinary requests to it; the menubar (`Iterate.swift:320-344`) drives its own per-request local banners from the same unchanged vocabulary — its banner flood remains the named follow-up. Zero code changes._

## Demo recipe

**Phone-only, any deployment (preview included)** — no laptop step: open a DISPOSABLE project in the mobile app → Examples screen (chat list header) → run **"Grouped approvals demo: a 12-request burst, ONE push"** (catalogue id `grouped-approvals-demo`). It REPLACES the project's egress rules with one hold on `dummy-petshop.iterate.com`, waits ~6s for the egress gate's rules cache, then fires 12 GETs in one `Promise.all` burst from the run-script isolate. Expect ONE push ("Script run waiting: 12 requests (12x dummy-petshop.iterate.com)") ~3s after the burst; tapping it deep-links to the expanded group; Approve all = one Face ID; the example then shows twelve 200s. Device must be enrolled for push + an approval key on the project. Holds expire after 10 minutes.

**Laptop wrapper** (same catalogue entry, via `capabilityHost.runScript` — one source of truth):

```bash
# a disposable project to demo against (its egress rules get REPLACED)
doppler run --config dev -- pnpm cli itx run -e 'return (await itx.projects.get("grouped-approvals-demo").create({})).__describe()'

cd apps/os
doppler run --config dev -- pnpm cli demo-grouped-approvals run --project prj_… [--requests 12]
```

The wrapper prints the collapsed push intent as the window fires, then blocks until the holds are decided (fallback without a phone: `iterate approve`, or grant via `pnpm cli itx run`). Point it at other deployments with the matching doppler config / `--base-url`.

## Out of scope

- Menubar app's own local-banner flood (`packages/iterate/menubar/Iterate.swift:320-344`) — named follow-up
- Non-HTTP approval holds (`tasks/approvals-beyond-http-egress.md`); capability-call-stack provenance (`tasks/capability-invocation-context.md`) — design composes, nothing more
- Web dashboard approvals UI; Android; batch signature schemes; egress rule schema changes

## Guesses and assumptions

- 3s/10s debounce numbers are taste — tunable constants `[guess]` _shipped as `APPROVAL_GROUP_DEBOUNCE_WINDOW_MS`/`APPROVAL_GROUP_DEBOUNCE_CAP_MS`_
- One SecureStore retrieval → one Face ID prompt covers N signatures (confirm on device) `[guess]` _still needs the on-device confirmation — JS-only change, runs on the existing dev client_
- Script source is the approver's real trust signal, so surface it from the group header `[guess]`
- Pruning on all-resolved-or-expired suffices; no separate GC sweep `[guess]` _held: reduce prunes on resolved-or-expired per event createdAt; the only residual is a group whose expiry rejections never land, which re-checks on a bounded alarm cadence_
- CLI/menubar need verification only, zero code changes `[guess]` _confirmed, see checklist_

## Implementation log

- Debounce state machine, contract, DO alarm-slice wiring, unit tests: commit `bc7d5f53c`. Mobile lib (`groupOpenRequests`, `signManyWithApproverKey`, `grantMany`): `1c03cc15d`. Grouped UI + deep link: `04962347a`. Demo CLI + e2e smoke: `199ac3379`.
- Design deviation (small): pruning does NOT wait for the window to fire — a group whose members are all resolved/expired has nothing left to push, so the suppress-if-empty outcome is reached by pruning early; the alarm's fire pass then finds no due group. Same observable behavior, simpler fold.
- The summary intent closes its window by being consumed back through the processor (it's in `consumes`), keeping the whole state machine a pure fold; a fire-time crash replays into an observe-and-skip on the idempotency key.
- Pre-existing, unrelated: `egress-approvals.e2e.test.ts` › "approved worker WebSocket egress stays on the fetch-native transport" fails on THIS laptop's local dev servers ("WebSocket echo failed") — reproduced identically at the merge-base commit `109a5714c` in a clean control worktree, so not introduced by this branch.
- Phone-trial feedback round: the RECENT section grouped too — `groupResolvedRequests` mirrors `groupOpenRequests` with a decision summary ("9 approved · 3 rejected"), and the screen derives a 50-deep window, groups, THEN caps rendered rows at 5 (the flat limit-5 derivation had truncated the 12-burst into five identical "Approved" cards); read-only `ResolvedGroupCard` renders the group. Also fixed foreground pushes: the app never called expo-notifications `setNotificationHandler`, so iOS suppressed banners while the app was open (confirmed on-device) — a minimal JS-only handler now shows banner+list+sound, no native rebuild needed.
- Follow-up (coordinator): the demo is now the itx catalogue example `grouped-approvals-demo` (`apps/os/src/itx/examples-source.ts`) so Misha can trial it from the PHONE against a PREVIEW — `context: "project"`, `runtimes: ["run-script"]` only (grouping needs the isolate's script-execution provenance; any other runtime would take the 12-push per-request path). Target host: `dummy-petshop.iterate.com` (our deployed fake service — no localhost echo, so it works from deployed workers; the echo-based CLI demo was dropped). Rule propagation: read-your-writes via `processor.waitUntilProcessed` + a 6s sleep to outwait the egress gate's ~5s rules cache. `e2eProven: false` with rationale in `e2e/examples/example-cases.ts` (blocks on a human by design). The CLI script became a thin wrapper running the same entry through `capabilityHost.runScript`. Verified live on a dev server: burst of 5 → `push intent fired: Script run waiting: 5 requests (5x dummy-petshop.iterate.com) → {"kind":"approvals-group",…}` → grant-all → `{"statuses":[200,200,200,200,200]}`.

## For the next pass (follow-ups)

- Menubar local-notification debounce (Swift-side)
- "Trust the rest of this run for this rule" — run-scoped standing grant covering future unseen requests (bigger trust-semantics change, deliberately excluded from v1)
- `tasks/extract-approvals-protocol-to-package.md` would deduplicate approve-core ↔ mobile approvals lib, where the grouping derivation could live once

## Follow-ups spotted during phone trial (pre-existing, not this branch)

- `apps/mobile/src/lib/build-info.ts` `BUILD_TIMESTAMP` is a hardcoded constant (stuck at 2026-07-18) rendered in the app footer — should be stamped at build/bundle time so it actually identifies the running JS.
- Projects screen with an unreachable server shows only "itx WebSocket closed before connecting" + Retry; the only escape is Sign out (top right), which isn't obviously a server switcher. Consider surfacing "change server" on connection failure.
- **Foreground pushes are silently swallowed**: the app never calls `expo-notifications` `setNotificationHandler`, so iOS suppresses banners while the app is foregrounded — exactly when someone runs the demo and stares at the Approvals screen. On the misha2 trial the grouped push WAS accepted by Expo (ticket `019f9680-…` 1s after the intent, correct body) but no banner showed. Fix: set a foreground handler (at minimum for approvals pushes).
- ~~**Script runs don't reliably survive parked egress holds** (REPRODUCED, 2 of 3 demo runs)~~ _fixed on main by #2312 ("Parked egress holds survive stream Durable Object restarts"), merged into this branch_: the run settles `failed / stream-unavailable: Network connection lost` while its fetches are parked awaiting approval, and once the caller is dead the released holds race cancellation — some settle 200, the rest strand as "submitted — awaiting the egress door…" until 10-min expiry. Incident A (23:41:29Z, run `f708de82`, Examples screen): died 56s into the wait, the same second the 12 grants landed; 9/12 settled, 3 stranded. Incident B (04:27:08Z, run `agent-output:313` on `/agents/mobile/2026-07-25t04-26-06-377z` — agent-chat-driven): died ~19s into the wait, 1s BEFORE the grants; 8/12 settled, 4 stranded (offsets 1192/1195/1198/1201). The agent's retry run (04:27:24) then completed cleanly: 12/12 granted and settled — so the failure is a race, not a hard limit. This is foundational for egress approvals generally (parked fetches must survive MINUTES of human latency): (a) the run's held-fetch/settlement path must tolerate DO connection recycling, (b) holds whose caller vanished need a terminal fact sooner than expiry so approver UIs don't show zombies. Deserves its own task + grilling; approve-all merely makes it visible every time by parking 12 fetches at once. Same trials also logged `subscription "project-worker" skipped poison event … Unable to deserialize cloned data` (offsets 10-11) — more preview stream-DO instability, see also tasks/project-creation-wedge-preview7.md (root worktree).

## Phone-trial result (misha2, preview 7, 2026-07-24 23:40Z)

The core feature is CONFIRMED on device: 12 holds → exactly ONE grouped push intent ("Script run waiting: 12 requests (12x dummy-petshop.iterate.com)") → "Approve all 12" → **one Face ID produced all 12 grants** (all keyId `4bef9c9d5a414be8`, appended within ~1s — the one-unlock-covers-N guess is now fact) → 9/12 settled with 200 before the run's stream connection dropped (see follow-up above).
