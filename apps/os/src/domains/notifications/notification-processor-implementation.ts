import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ProcessorReads, ReduceArgs } from "iterate/processors";
import {
  NotificationProcessorContract,
  type NotificationProcessorState,
} from "./notification-processor-contract.ts";

/**
 * The project's notification-policy processor: it decides WHICH project
 * domain facts deserve a human notification and journals each decision as
 * one channel-neutral `notification/requested` intent. It knows nothing
 * about channels — delivery (the device processor's cross-post subscription
 * today) independently resolves the audience to recipients and journals its
 * own outcomes.
 *
 * HOW IT WORKS, end to end: the processor subscribes on the project ROOT
 * stream (registered by the project durable object next to the project
 * processor; project bootstrap appends its `notification/created` birth
 * certificate there). When the egress door parks an outbound request behind
 * a human decision (`project/human-approval-requested`), this processor
 * appends one `notification/requested` intent pointing everyone in the
 * project at the approvals screen. The approval event's offset IS the held
 * request's identity: it rides in the intent's destination (so a tap
 * deep-links to exactly that held request) and in the intent's idempotency
 * key (so redeliveries collapse to one intent). The intent body is
 * deterministic from the approval event alone — `expiresAt` copies the
 * approval's own horizon, never `now` — so an at-least-once redelivery
 * re-appends the identical body and dedupes on the key instead of wedging
 * the frame with a same-key conflict.
 *
 * The processor is stateless per event EXCEPT for one documented state
 * machine (ADR 0006): holds carrying a script-execution streamContext are
 * grouped per Script Execution into an Approval Group instead of pushed
 * individually — a `Promise.all` burst of N holds must not buzz the phone N
 * times. `reduce` folds those holds into per-executionId debounce state (a
 * short window that each new hold extends, capped), the at-head pass derives
 * the next alarm from that state exactly like SchedulerProcessor, and the
 * hosting Durable Object's alarm calls {@link fireDueApprovalGroupWindows},
 * which appends ONE summary intent per due window covering the group's FULL
 * currently-open set. The intent reduces back through this processor to
 * close its window; holds landing after a fired window open a fresh window
 * (and a fresh push) with a fresh idempotency key. Entries prune once every
 * member is resolved or expired, so state stays bounded.
 */
export class NotificationProcessor extends StreamProcessor<
  NotificationProcessorContract,
  NotificationProcessorDeps
> {
  readonly contract = NotificationProcessorContract;

  protected override processEvent(
    args: ProcessEventArgs<NotificationProcessorContract>,
  ): undefined {
    const { event, state, delivery, append, blockProcessorWhile } = args;
    switch (event?.type) {
      case "events.iterate.com/project/human-approval-requested": {
        // Script-scoped holds ride the Approval Group debounce: reduce has
        // already folded this hold into its group's window, and the alarm
        // appends one summary intent per window. No per-request intent here.
        if (event.payload.streamContext?.kind === "script-execution") break;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/notification/requested",
            idempotencyKey: this.idempotencyKey("approval-requested", event),
            payload: {
              audience: { kind: "project" },
              title: "Approval needed",
              // Host only, never the full URL: paths and query strings can
              // leak intent details onto lock screens. An unparseable
              // "URL" (custom hold rules pass free text) renders verbatim.
              body: `${event.payload.method} ${approvalRequestHost(event.payload.url)} is waiting for approval.`,
              destination: {
                kind: "approvals",
                approvalRequestEventOffset: event.offset,
              },
              expiresAt: Date.parse(event.payload.expiresAt),
            },
          }),
        );
        break;
      }
      // notification/created and the approval resolutions have no per-event
      // effect — they matter through reduce; notification/requested is
      // consumed only so a fired group push closes its window in the fold.
    }

    // AT-HEAD alarm derivation, mirroring SchedulerProcessor: on every
    // at-head frame the next Approval Group wake is recomputed from the whole
    // observed fold and pushed at the platform alarm (the registry's
    // alarm-slice set is a no-op for an unchanged time). The await is
    // load-bearing — a silently lost repoint would strand a debounce window
    // with nothing left to fire it.
    if (!delivery.caughtUp) return;
    blockProcessorWhile(async () => {
      await this.deps.repointAlarm(nextApprovalGroupWakeAtMs(state, this.deps.now()));
    });
  }

  protected override reduce({
    event,
    state,
  }: ReduceArgs<NotificationProcessorContract>): NotificationProcessorState {
    switch (event.type) {
      case "events.iterate.com/notification/created":
        // Bootstrap's birth append is idempotency-keyed, but a duplicate that
        // slips through must reduce to a no-op, never wedge the frame.
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/project/human-approval-requested": {
        const streamContext = event.payload.streamContext;
        if (streamContext?.kind !== "script-execution") return state;
        const executionId = streamContext.executionId;
        const group = state.approvalGroups[executionId] || {
          members: {},
          notifiedThroughOffset: 0,
          window: null,
        };
        const heldAtMs = Date.parse(event.createdAt);
        return {
          ...state,
          approvalGroups: {
            ...state.approvalGroups,
            [executionId]: {
              ...group,
              members: {
                ...group.members,
                [event.offset]: {
                  expiresAtMs: Date.parse(event.payload.expiresAt),
                  host: approvalRequestHost(event.payload.url),
                  resolved: false,
                  ruleDescription: event.payload.ruleDescription,
                  ruleKey: event.payload.ruleKey,
                },
              },
              window:
                group.window === null
                  ? { firstHeldOffset: event.offset, lastHeldAtMs: heldAtMs, opensAtMs: heldAtMs }
                  : { ...group.window, lastHeldAtMs: heldAtMs },
            },
          },
        };
      }
      case "events.iterate.com/project/human-approval-granted":
      case "events.iterate.com/project/human-approval-rejected":
      case "events.iterate.com/project/human-approval-settled": {
        const memberKey = String(event.payload.approvalRequestEventOffset);
        const found = Object.entries(state.approvalGroups).find(
          ([, group]) => group.members[memberKey] !== undefined,
        );
        if (found === undefined) return state;
        const [executionId, group] = found;
        const updated = {
          ...group,
          members: {
            ...group.members,
            [memberKey]: { ...group.members[memberKey]!, resolved: true },
          },
        };
        return withApprovalGroup(state, executionId, updated, Date.parse(event.createdAt));
      }
      case "events.iterate.com/notification/requested": {
        // A fired Approval Group push closes its window. Every member offset
        // is below this intent's offset (holds commit before the summary), so
        // closing unconditionally is exact; later holds open a fresh window.
        const destination = event.payload.destination;
        if (destination.kind !== "approvals-group") return state;
        const group = state.approvalGroups[destination.executionId];
        if (group === undefined || group.window === null) return state;
        const updated = {
          ...group,
          notifiedThroughOffset: Math.max(...Object.keys(group.members).map(Number)),
          window: null,
        };
        return withApprovalGroup(
          state,
          destination.executionId,
          updated,
          Date.parse(event.createdAt),
        );
      }
      default:
        return state;
    }
  }

  /**
   * Append one summary `notification/requested` per due Approval Group
   * window, then re-arm the alarm slice. The hosting Durable Object calls
   * this from `alarm()` after a catch-up (and unit tests call it directly
   * with a virtual clock — no real sleeps anywhere). Fire-time policy:
   *
   * - the push summarizes the group's FULL currently-open set (a statement
   *   about the world, not a changelog), so a straggler window's push counts
   *   earlier-window members that are still waiting;
   * - zero open members at fire time → no push (the user resolved everything
   *   while live-tailing); the members' own resolution/expiry events prune
   *   the entry via reduce, and the re-arm below just re-checks meanwhile;
   * - a crashed wake re-running against un-advanced state OBSERVES the
   *   committed push under the window's idempotency key and skips it — the
   *   open set may have changed, and a same-key different-body append is
   *   REJECTED by the stream, never deduplicated.
   */
  async fireDueApprovalGroupWindows(): Promise<{ notified: number }> {
    const { state } = await this.deps.reads.snapshot();
    const now = this.deps.now();
    let notified = 0;
    for (const [executionId, group] of Object.entries(state.approvalGroups)) {
      if (group.window === null || approvalGroupFireAtMs(group.window) > now) continue;
      const openMembers = Object.values(group.members).filter(
        (member) => !member.resolved && member.expiresAtMs > now,
      );
      if (openMembers.length === 0) continue;
      const idempotencyKey = this.idempotencyKey(
        `approval-group@${executionId}:${group.window.firstHeldOffset}`,
      );
      const committed = await this.stream.getEvent({ idempotencyKey });
      if (committed !== undefined) continue;
      await this.append({
        type: "events.iterate.com/notification/requested",
        idempotencyKey,
        payload: {
          audience: { kind: "project" },
          title: openMembers.length === 1 ? "Approval needed" : "Approvals needed",
          body: approvalGroupPushBody(openMembers),
          destination: { kind: "approvals-group", executionId },
          // The group's furthest member horizon: while any member is still
          // decidable the summary is worth delivering.
          expiresAt: Math.max(...openMembers.map((member) => member.expiresAtMs)),
        },
      });
      notified += 1;
    }
    // Re-arm from the pre-append fold: a just-fired window only closes when
    // its intent reduces, so its past-due fire time re-arms on the re-check
    // cadence (see nextApprovalGroupWakeAtMs) and the post-catch-up at-head
    // repoint then corrects the slice.
    await this.deps.repointAlarm(nextApprovalGroupWakeAtMs(state, now));
    return { notified };
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

/**
 * Runtime dependencies the hosting Durable Object injects — everything time-
 * or platform-shaped, so unit tests drive the debounce with a virtual clock
 * and a spy alarm.
 */
export type NotificationProcessorDeps = {
  /** Injectable clock. Only alarm derivation and fire-time reads use it — reduce never does. */
  now: () => number;
  /**
   * Repoint (or, with null, delete) the notification slice of the platform
   * alarm. Called at the head of every delivery and after every
   * fireDueApprovalGroupWindows; the at-head await is load-bearing (a failed
   * repoint must fail the frame so the transport redelivers it).
   */
  repointAlarm: (atMs: number | null) => void | Promise<void>;
  /**
   * RUNNER-backed read of the committed reduced state, for fire-time
   * decisions made outside a delivery hook. The hosting DO wires this to
   * `registry.reads(processor)`; the unit harness wires it to the driving
   * StreamProcessorRunner.
   */
  reads: Pick<ProcessorReads<NotificationProcessorState>, "snapshot">;
};

// -----------------------------------------------------------------------------
// Pure helpers — the debounce arithmetic unit tests exercise directly.
// -----------------------------------------------------------------------------

/** Debounce window per Approval Group: opens on the first hold, extended by
 * each subsequent hold. Tunable taste, not physics (tasks/grouped-approvals.md). */
export const APPROVAL_GROUP_DEBOUNCE_WINDOW_MS = 3_000;
/** Hard cap on window extension, so a drip-feeding script cannot postpone the
 * first push forever. */
export const APPROVAL_GROUP_DEBOUNCE_CAP_MS = 10_000;

type ApprovalGroup = NotificationProcessorState["approvalGroups"][string];

/** When an un-fired window is due: the last hold's debounce, capped from the window's opening. */
export function approvalGroupFireAtMs(window: NonNullable<ApprovalGroup["window"]>): number {
  return Math.min(
    window.lastHeldAtMs + APPROVAL_GROUP_DEBOUNCE_WINDOW_MS,
    window.opensAtMs + APPROVAL_GROUP_DEBOUNCE_CAP_MS,
  );
}

/**
 * The earliest Approval Group wake the fold wants, or null when no window is
 * open. A PAST-DUE window here is one that could not close at its fire time —
 * a suppressed push whose members' expiry rejections are still in flight, or
 * a fired intent not yet reduced — so it re-arms one debounce window out (a
 * bounded re-check) instead of hot-looping an immediate alarm.
 */
export function nextApprovalGroupWakeAtMs(
  state: NotificationProcessorState,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const group of Object.values(state.approvalGroups)) {
    if (group.window === null) continue;
    const fireAt = approvalGroupFireAtMs(group.window);
    const at = fireAt <= nowMs ? nowMs + APPROVAL_GROUP_DEBOUNCE_WINDOW_MS : fireAt;
    next = next === null ? at : Math.min(next, at);
  }
  return next;
}

/** "Script run waiting: 12 requests (10x gmail.googleapis.com, 2x api.stripe.com)" —
 * host-only lock-screen privacy, busiest host first. */
export function approvalGroupPushBody(members: { host: string }[]): string {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.host, (counts.get(member.host) || 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([hostA, countA], [hostB, countB]) => countB - countA || hostA.localeCompare(hostB))
    .map(([host, count]) => `${count}x ${host}`)
    .join(", ");
  return `Script run waiting: ${members.length} request${members.length === 1 ? "" : "s"} (${breakdown})`;
}

/**
 * Store one group's next incarnation — or PRUNE the whole entry once every
 * member is resolved or expired (per the reducing event's own clock, keeping
 * the fold pure). Pruning does not wait for the window to fire: a window
 * whose members all resolved has nothing left to push (fire time would
 * suppress it anyway), and dropping it here is what keeps a long-lived
 * project from accumulating one entry per script run.
 */
function withApprovalGroup(
  state: NotificationProcessorState,
  executionId: string,
  group: ApprovalGroup,
  eventCreatedAtMs: number,
): NotificationProcessorState {
  const prunable = Object.values(group.members).every(
    (member) => member.resolved || member.expiresAtMs <= eventCreatedAtMs,
  );
  if (prunable) {
    const { [executionId]: _pruned, ...approvalGroups } = state.approvalGroups;
    return { ...state, approvalGroups };
  }
  return { ...state, approvalGroups: { ...state.approvalGroups, [executionId]: group } };
}

/** The host of the held request's target, for the notification body. Custom
 * hold rules can park free-text "URLs"; those render verbatim rather than
 * suppressing the notification. */
function approvalRequestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
