// The scheduler's itx-facing RPC shapes. The event payload/state schemas live
// on the processor contract (scheduler-processor-contract.ts), whose zod
// schemas `satisfies`-check against these hand-written public unions — the
// public type stays a clean strict union while the wire schemas stay loose.

/**
 * When a Schedule triggers. Exactly one canonical spelling per shape: a single
 * ISO instant (`at`), a seconds interval re-anchored on each trigger
 * (`every`), or a cron expression with optional IANA timezone (`cron`).
 * Sub-minute rates belong to `every`; calendar points belong to `cron`.
 */
export type SchedulerRecurrence =
  | { at: string }
  | { every: number }
  | { cron: string; timezone?: string };

/**
 * What a Schedule does when it triggers. A closed union so an `append` kind
 * can be added later; the only kind today is running an itx script — a
 * function-expression string invoked as `fn(itx, schedule, trigger)` with
 * project-root itx authority.
 */
export type SchedulerAction = {
  kind: "itx-script";
  /** A function-expression string, invoked as `fn(itx, schedule, trigger)`. */
  script: string;
};

/**
 * Input to `scheduler.set(...)`: a keyed upsert. `recurrence` additionally
 * accepts `{ in: seconds }` sugar, converted to a canonical `{ at }` before
 * anything is appended — the event log has exactly one spelling of every
 * schedule.
 */
export type SetScheduleInput = {
  key: string;
  metadata?: Record<string, unknown>;
  recurrence: SchedulerRecurrence | { in: number };
  /**
   * itx script source: `async (itx, schedule, trigger) => { ... }`. A string,
   * not a function — closures would silently not survive serialization.
   * `schedule` is `{ key, path, recurrence, metadata?, setAt }` (`path` is the
   * Scheduler stream this Schedule lives on); `trigger` is `{ executionId,
   * scheduledFor, requestedAt, runCount }`. The itx is project-root scoped —
   * `await itx.projectId` identifies the project.
   */
  script: string;
};

/** One Schedule as reduced from the Scheduler stream — the UI list row. */
export type ScheduleView = {
  action: SchedulerAction;
  /** Offset of the `schedule-set` event that defined this version (audit provenance). */
  definedAtOffset: number;
  key: string;
  metadata?: Record<string, unknown>;
  /** ISO time of the next occurrence; null when exhausted or unparseable. */
  nextTriggerAt: string | null;
  recurrence: SchedulerRecurrence;
  /** Triggers requested for this key since it was (re)set. */
  runCount: number;
  /** When this version of the Schedule was set. */
  setAt: string;
};
