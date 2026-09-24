// context/residency-watchdog.ts — THE RESIDENCY WATCHDOG's one decision, pure. The platform evicts an
// idle context ~10 s after its last call and hibernates one that holds only hibernatable sockets; a
// context still resident a whole window after its last inbound call, with nothing in flight, is HELD
// — a leaked Workers-RPC session (a facet or a client keeping a live stub the context handed out), a
// response body still streaming, its own sub-10-s alarms — and billed the whole time. LOG-ONLY: the
// context records it (`events.iterate.com/context/held-resident-while-idle` and a `console.warn`);
// nothing is aborted.
//
// A DURABLE ALARM, NEVER A TIMER (measured on a deployed preview, 2026-09-23): a pending `setTimeout`
// holds off eviction AND hibernation for its full length, billed (a 900 s timer: 900 s billed per
// touch with the caller connected, ~73 s after it leaves); an alarm holds off neither (8/8 evicted,
// 8/8 hibernated) and still fires in a pinned incarnation on time (6/6). So the deadline is one of
// the in-memory sources of the context's one alarm (alarm-coordinator.ts): a fresh
// incarnation has none — its armer was evicted, the normal end — so the alarm it is woken by does
// nothing. Armed by an inbound call when none is armed: one alarm write per quiet window, not per call.

/** How long a context may stay resident with no inbound call and nothing in flight before it is
 *  recorded as held. Far above every legitimate call-free residency (the pins' 30 s release, a facet
 *  call's 60 s watchdog, the 70–140 s a non-hibernatable idle actor lingers), so a record is never a
 *  platform grace period; a quarter hour of a held actor is ~115 GB-s (~$0.0014) before it is seen;
 *  and a context used more often than this never gets the no-op wake at all. */
export const RESIDENCY_WATCHDOG_WINDOW_MS = 15 * 60_000;

/** What the alarm does about a quiet deadline: nothing (none armed, or not yet due), move it, or it
 *  is due, quiet since `idleSince`. */
export type QuietDeadlineDecision =
  | { action: "none" }
  | { action: "rearm"; at: number }
  | { action: "due"; idleSince: number };

/** Shared by the residency watchdog (due: record) and the unclaimed-facet sweep (due: reset), each
 *  with its own window and clock. */
export function decideQuietDeadline(input: {
  /** The deadline this incarnation armed, epoch ms, or null — a fresh incarnation armed nothing. */
  armedFor: number | null;
  now: number;
  /** When this incarnation's last inbound call ended, or null while none has. */
  lastCallEndedAt: number | null;
  /** Inbound calls, facet calls, script runs and pin calls in flight right now. */
  workInFlight: number;
  windowMs: number;
}): QuietDeadlineDecision {
  const { armedFor, now, lastCallEndedAt, workInFlight, windowMs } = input;
  if (armedFor === null || now < armedFor) return { action: "none" };
  if (workInFlight > 0) return { action: "rearm", at: now + windowMs };
  // Nothing in flight means the call that armed it has ended; the arming instant is the fallback.
  const idleSince = lastCallEndedAt ?? armedFor - windowMs;
  if (now - idleSince < windowMs) return { action: "rearm", at: idleSince + windowMs };
  return { action: "due", idleSince };
}
