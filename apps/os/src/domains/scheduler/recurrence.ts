import { Cron } from "croner";
import type { SchedulerRecurrence, SetScheduleInput } from "./types.ts";
import type { SchedulerProcessorState } from "./scheduler-processor-contract.ts";

// =============================================================================
// Pure scheduler time math. Everything here is a total function of its inputs
// (no Date.now(), no I/O) so reduce stays deterministic under replay and the
// interesting behavior is unit-testable without a Durable Object.
// =============================================================================

/**
 * While the scheduler holds ANY state, its alarm re-arms at most this far
 * out. The heartbeat is the self-healing backstop when a processor wake is lost
 * (a schedule set while event sending is stuck costs at most one heartbeat
 * of latency) and re-launches pending executions orphaned by a mid-run
 * Durable Object restart. An EMPTY scheduler deletes its alarm instead —
 * there is nothing to heal, and the command path re-arms on the next set.
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
 * coalesce into the one Trigger that already ran; intervals drift by
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
 * trigger, clamped below by a minimum delay and above by the heartbeat. Null
 * — delete the alarm — only when the scheduler holds no state at all;
 * anything else (parked schedules, pending executions) keeps the heartbeat so
 * the sweep can heal it.
 */
export function nextWakeAtMs(
  state: Pick<SchedulerProcessorState, "pendingTriggers" | "schedules">,
  nowMs: number,
): number | null {
  const schedules = Object.values(state.schedules);
  if (schedules.length === 0 && Object.keys(state.pendingTriggers).length === 0) return null;
  let wakeAtMs = nowMs + SCHEDULER_HEARTBEAT_MS;
  for (const entry of schedules) {
    if (entry.nextTriggerAt === null) continue;
    wakeAtMs = Math.min(wakeAtMs, Math.max(entry.nextTriggerAt, nowMs + MIN_WAKE_DELAY_MS));
  }
  return wakeAtMs;
}

/**
 * A wake that made no progress (its trigger requests all deduped against
 * events the reduced state has not been able to advance past — a wedged
 * delivery or a stuck-due schedule) backs off exponentially toward the
 * heartbeat instead of re-arming at the minimum delay forever.
 */
export function barrenWakeAtMs(nowMs: number, consecutiveBarrenWakes: number): number {
  return nowMs + Math.min(SCHEDULER_HEARTBEAT_MS, MIN_WAKE_DELAY_MS * 2 ** consecutiveBarrenWakes);
}

/**
 * Fail-loud recurrence validation for the set path: exactly one recurrence
 * shape, and a cron/timezone that croner rejects — or that has no future
 * occurrence at all — must fail at set time, not silently at 3am. Raw appends
 * can still bypass this; reduce handles those totally by parking the entry.
 */
export function assertValidRecurrence(recurrence: SchedulerRecurrence): void {
  const shapeKeys = ["at", "every", "cron"].filter((key) => key in recurrence);
  if (shapeKeys.length !== 1) {
    throw new Error(
      `recurrence must have exactly one of "at" | "every" | "cron", got { ${shapeKeys.join(", ")} }`,
    );
  }
  if (!("cron" in recurrence)) return;
  // Constructing the Cron validates the expression; croner only evaluates the
  // timezone lazily, so force one occurrence computation too.
  const next = new Cron(recurrence.cron, { timezone: recurrence.timezone }).nextRun();
  if (next === null) {
    throw new Error(`cron "${recurrence.cron}" has no future occurrence`);
  }
}

/**
 * Lower a `set()` recurrence to its canonical stored form. `{ in: seconds }`
 * is API sugar only — the event log has exactly one spelling of every
 * schedule, so it lowers to `{ at }` before anything is appended.
 */
export function canonicalRecurrence(
  recurrence: SetScheduleInput["recurrence"],
  nowMs: number,
): SchedulerRecurrence {
  if ("in" in recurrence) {
    if (!Number.isInteger(recurrence.in) || recurrence.in <= 0) {
      throw new Error(`recurrence.in must be a positive integer of seconds, got ${recurrence.in}`);
    }
    return { at: new Date(nowMs + recurrence.in * 1000).toISOString() };
  }
  return recurrence;
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
