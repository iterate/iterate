import { Cron } from "croner";
import type { SchedulerRecurrence } from "../../types.ts";
import type { SchedulerProcessorState } from "./scheduler-processor-contract.ts";

// =============================================================================
// Pure scheduler time math. Everything here is a total function of its inputs
// (no Date.now(), no I/O) so the fold stays deterministic under replay and the
// interesting behavior is unit-testable without a Durable Object.
// =============================================================================

/**
 * The scheduler Durable Object never leaves itself alarm-less: even with
 * nothing due, the alarm re-arms at most this far out. The heartbeat is the
 * self-healing backstop for lost subscriber wakes (a schedule set while the
 * push chain is wedged costs at most one heartbeat of latency) and re-launches
 * pending executions orphaned by a mid-run Durable Object restart.
 */
export const SCHEDULER_HEARTBEAT_MS = 15 * 60_000;

// Due-now entries are re-armed at least this far out so a wake that raced its
// own append can't hot-loop the alarm.
const MIN_WAKE_DELAY_MS = 1_000;

/**
 * First due time for a recurrence defined at `baseMs` (the set event's
 * `createdAt`). Null when the recurrence has no occurrence (cron with no
 * future match, or an unparseable expression from a raw append) — reduce is
 * total, so bad input parks the schedule visibly instead of throwing.
 */
export function initialTriggerAtMs(recurrence: SchedulerRecurrence, baseMs: number): number | null {
  if ("at" in recurrence) {
    const atMs = Date.parse(recurrence.at);
    return Number.isFinite(atMs) ? atMs : null;
  }
  if ("every" in recurrence) return baseMs + recurrence.every * 1000;
  return nextCronMs(recurrence, baseMs);
}

/**
 * Next due time after a Trigger was requested at `requestedAtMs`; null for
 * exhausted one-shots. `every` re-anchors from the request (missed occurrences
 * coalesce into the one Trigger that already fired; intervals drift by
 * execution latency — fixed-phase timing is what `cron` is for).
 */
export function nextTriggerAtMs(
  recurrence: SchedulerRecurrence,
  requestedAtMs: number,
): number | null {
  if ("at" in recurrence) return null;
  if ("every" in recurrence) return requestedAtMs + recurrence.every * 1000;
  return nextCronMs(recurrence, requestedAtMs);
}

/**
 * Schedules due at `nowMs`, ordered by due time then key so trigger events
 * land in a stable order.
 */
export function dueSchedules(
  schedules: SchedulerProcessorState["schedules"],
  nowMs: number,
): [string, SchedulerProcessorState["schedules"][string]][] {
  return Object.entries(schedules)
    .filter(([, entry]) => entry.nextTriggerAt !== null && entry.nextTriggerAt <= nowMs)
    .sort(([leftKey, left], [rightKey, right]) => {
      return left.nextTriggerAt! - right.nextTriggerAt! || leftKey.localeCompare(rightKey);
    });
}

/**
 * When the Durable Object alarm should fire next: the earliest upcoming
 * trigger, clamped below by a minimum delay and above by the heartbeat.
 * Always returns a time — the alarm is never deleted (see
 * SCHEDULER_HEARTBEAT_MS).
 */
export function nextWakeAtMs(state: SchedulerProcessorState, nowMs: number): number {
  let wakeAtMs = nowMs + SCHEDULER_HEARTBEAT_MS;
  for (const entry of Object.values(state.schedules)) {
    if (entry.nextTriggerAt === null) continue;
    wakeAtMs = Math.min(wakeAtMs, Math.max(entry.nextTriggerAt, nowMs + MIN_WAKE_DELAY_MS));
  }
  return wakeAtMs;
}

/**
 * Fail-loud recurrence validation for the set path: a cron expression or
 * timezone croner rejects must fail at set time, not silently at 3am. Raw
 * appends can still bypass this — reduce handles those totally.
 */
export function assertValidRecurrence(recurrence: SchedulerRecurrence): void {
  if (!("cron" in recurrence)) return;
  // Constructing the Cron validates the expression; croner only evaluates the
  // timezone lazily, so force one occurrence computation too.
  new Cron(recurrence.cron, { timezone: recurrence.timezone }).nextRun();
}

function nextCronMs(
  recurrence: Extract<SchedulerRecurrence, { cron: string }>,
  afterMs: number,
): number | null {
  try {
    const next = new Cron(recurrence.cron, { timezone: recurrence.timezone }).nextRun(
      new Date(afterMs),
    );
    return next === null ? null : next.getTime();
  } catch {
    return null;
  }
}
