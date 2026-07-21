import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { NotificationProcessorContract } from "./notification-processor-contract.ts";

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
 * The reduce is only the birth certificate; every emitted intent derives
 * from its triggering event, not from accumulated state.
 */
export class NotificationProcessor extends StreamProcessor<NotificationProcessorContract> {
  readonly contract = NotificationProcessorContract;

  protected override processEvent(
    args: ProcessEventArgs<NotificationProcessorContract>,
  ): undefined {
    const { event, append, blockProcessorWhile } = args;
    switch (event?.type) {
      case "events.iterate.com/project/human-approval-requested": {
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
      // notification/created: no per-event effect — it matters through reduce.
    }
  }

  protected override reduce({ event, state }: ReduceArgs<NotificationProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/notification/created":
        // Bootstrap's birth append is idempotency-keyed, but a duplicate that
        // slips through must reduce to a no-op, never wedge the frame.
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload };
      default:
        // project/human-approval-requested: consumed only for its delivery
        // turn; no state change.
        return state;
    }
  }
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
