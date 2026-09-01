import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  NotificationProcessorContract,
  type NotificationProcessorState,
} from "./notification-processor-contract.ts";

/**
 * The project's notification-policy processor: it decides WHICH project
 * domain facts deserve a human notification and journals each decision as
 * one channel-neutral `notification/requested` intent. It knows nothing
 * about channels — delivery (the device processor's copy subscription
 * today) independently resolves the audience to recipients and journals its
 * own outcomes.
 *
 * HOW IT WORKS, end to end: the processor subscribes on the project ROOT
 * stream (registered by the project durable object next to the project
 * processor; project bootstrap appends its `notification/created` birth
 * certificate there). When the egress door parks an approval batch behind a
 * human decision (`project/human-approval-requested` — one event per batch,
 * a lone request is a batch of one), this processor appends one
 * `notification/requested` intent pointing everyone in the project at the
 * approvals screen. The batch event's offset IS the batch's identity: it
 * rides in the intent's destination (so a tap deep-links to exactly that
 * batch) and in the intent's idempotency key (so redeliveries collapse to
 * one intent). The intent body is deterministic from the batch event alone —
 * `expiresAt` copies the batch's own horizon, never `now` — so an
 * at-least-once redelivery re-appends the identical body and dedupes on the
 * key instead of wedging the frame with a same-key conflict.
 *
 * Stateless per event, with no exceptions: the egress door already
 * coalesced a script run's burst into ONE batch event (ADR 0007), so one
 * push per event is exactly one push per human decision.
 */
export class NotificationProcessor extends StreamProcessor<NotificationProcessorContract> {
  readonly contract = NotificationProcessorContract;

  protected override processEvent(
    args: ProcessEventArgs<NotificationProcessorContract>,
  ): undefined {
    const { event, append, blockProcessorWhile } = args;
    switch (event?.type) {
      case "events.iterate.com/project/human-approval-requested": {
        // A batch born of an agent thread's run deep-links to THAT thread —
        // the in-thread dialog is the better approval surface, and the
        // approvals screen remains reachable as the queue/history view.
        // Everything else (scope holds, non-agent scripts) keeps the
        // approvals-screen destination.
        const streamContext = event.payload.streamContext;
        const agentPath =
          streamContext?.kind === "script-execution" &&
          streamContext.streamPath.startsWith("/agents/")
            ? streamContext.streamPath
            : null;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/notification/requested",
            idempotencyKey: this.idempotencyKey("approval-requested", event),
            payload: {
              // Top-level on BOTH destination kinds: the suppression handle a
              // project/approval-presented claim matches against (the
              // agent-chat destination carries no batch identity of its own).
              approvalRequestEventOffset: event.offset,
              audience: { kind: "project" },
              title: event.payload.requests.length === 1 ? "Approval needed" : "Approvals needed",
              body: approvalPushBody(event.payload.requests),
              requests: event.payload.requests.map((request) => ({
                method: request.method,
                url: request.url,
              })),
              destination: agentPath
                ? { kind: "agent-chat", path: agentPath }
                : { kind: "approvals", approvalRequestEventOffset: event.offset },
              expiresAt: Date.parse(event.payload.expiresAt),
            },
          }),
        );
        break;
      }
      // notification/created has no per-event effect — it matters through
      // reduce (the birth certificate).
    }
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
      default:
        return state;
    }
  }
}

/**
 * The push body for one approval batch. Host only, never the full URL:
 * paths and query strings can leak intent details onto lock screens. A lone
 * request reads exactly as it always has; a batch summarizes by host,
 * busiest first — "Script run waiting: 12 requests (10x gmail.googleapis.com,
 * 2x api.stripe.com)" (only a script run's burst ever batches).
 */
function approvalPushBody(requests: Array<{ method: string; url: string }>): string {
  if (requests.length === 1) {
    const only = requests[0]!;
    return `${only.method} ${approvalRequestHost(only.url)} is waiting for approval.`;
  }
  const counts = new Map<string, number>();
  for (const request of requests) {
    const host = approvalRequestHost(request.url);
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort(([hostA, countA], [hostB, countB]) => countB - countA || hostA.localeCompare(hostB))
    .map(([host, count]) => `${count}x ${host}`)
    .join(", ");
  return `Script run waiting: ${requests.length} requests (${breakdown})`;
}

/** The host of a held request's target. Custom hold rules can park free-text
 * "URLs"; those render verbatim rather than suppressing the notification. */
function approvalRequestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
