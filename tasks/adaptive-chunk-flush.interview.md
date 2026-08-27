# Interview: adaptive-chunk-flush

Grill-you session for the adaptive-window decoupling follow-up to PR #2531.
Interviewer: main session (standing in for Misha, bedtime run 2026-08-28).
Sub-claude: grill-with-docs, one question per turn.

---
## Q1 — merge mechanics: second buffer or the existing one? — 2026-08-28T00:0x
Does the merge need a second buffer, or does the existing single chunkBuffer already serve? Sub-claude recommends: single buffer, gate trigger on pendingFlush === null, and flush-on-settle bypassing the window/size gate.

## A1
Single buffer yes; pendingFlush: Promise|null gating. OVERRIDE on flush-on-settle: no settle-triggered flush at all — only chunk arrival triggers (pendingFlush === null AND gate), else DO commit rate becomes the cadence. Next chunk or completion tail picks up an eligible buffer. Invariant: flush cadence never exceeds ~1/window regardless of append speed. [guess: taste call between two workable designs — chose the leaner one]. Also: .catch at creation (unhandled-rejection hazard) + clear in finally (rejected append must not wedge the lane).

---
## Q2 — completion: await the chunk lane or fire-and-forget?
(a) await pendingFlush + one tail flush before the atomic settle (one-time cost, keeps no-chunk-after-settle invariant) vs (b) full fire-and-forget (settle can land before last window; consumers need post-settle rules). Sub-claude recommends (a). Also noted Q1's answer implicitly settles sequence numbering: rejected window = lost chunks, number never reused, gaps legal.

## A2
(a) agreed — the principle targets mid-stream delivery; turn-end is bookkeeping. ≤2 append latencies once per turn, bounded under degradation (settle is an append to the same DO anyway). Both awaits .catch-wrapped so a dead ephemeral lane can't fail/block the settle.

---
## Q3 — does pendingFlush need runInBackground/keepalive tracking?
Sub-claude's walkthrough: no — the streaming closure's own runInBackground wrapper spans every pendingFlush (attempt() blocks mid-stream; completion awaits stragglers). Eviction mid-flush = accepted pre-existing loss mode. Recommends: no new tracking.

## A3
Agreed, plus two refinements: (1) the CATCH path must also await pendingFlush before its tail flush (cap-of-one + sequence order), giving both completion paths an identical epilogue; (2) the ABORT path deliberately abandons a floating flush (same loss mode as eviction; partialText covers the UI) — document so nobody "fixes" it later.

---
## Q4 — unbounded buffer growth while pendingFlush busy: acceptable?
Sub-claude: yes — bounded by response size (partialText already duplicates it); MAX_BYTES stays the free-lane flush trigger, explicitly not a memory bound while busy; document it.

## A4
Agreed, plus the safety net that closes the residual worry: an oversized merged window whose own append rejects is just a lost window, and #2531's assistant-context-extends-windows reducer fix means even total chunk-lane loss self-heals in the UI at completion. All three points go in the task file.

---
## Q5 — replacement for the "backpressures chunk flushes" spec; ordering guarantee
Sub-claude: cap-of-one serializes flushes by construction (ordering survives for a new reason); old spec pins removed behavior — retire it; recommends two replacement specs (no-blocking, merge-into-next-window).

## A5
Fold the two into ONE story-shaped spec ("a pending flush never blocks the drain: later chunks merge into the next window"); retire the old spec. ADD a third pin: rejected in-flight flush doesn't wedge the lane (sequence gap, next window fires, delivery never stalls, settle succeeds). Serialization-by-construction gets a code comment, not a spec.

---
## Termination
Sub-claude walked every dossier branch, confirmed all resolved, said "ready for Phase 2".
