import { StreamProcessor } from "iterate/processors";
import { NotificationProcessorContract } from "./notification-processor-contract.ts";

export class NotificationProcessor extends StreamProcessor<NotificationProcessorContract> {
  readonly contract = NotificationProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<NotificationProcessorContract>["reduce"]>[0]) {
    if (event.type !== "events.iterate.com/notification/created") return state;
    if (state.birthCertificate !== null) {
      throw new Error("notification processor received more than one created event");
    }
    return { ...state, birthCertificate: event.payload };
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    state,
  }: Parameters<StreamProcessor<NotificationProcessorContract>["processEvent"]>[0]): undefined {
    if (event?.type === "events.iterate.com/notification/created") {
      blockProcessorWhile(() =>
        append({
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: this.idempotencyKey("email-cross-post", event),
          payload: {
            subscriptionKey: "notification-intent:/integrations/email",
            description:
              "Copies project notification intents to the built-in email channel for recipient resolution and delivery.",
            selector: { eventTypes: ["events.iterate.com/notification/requested"] },
            delivery: {
              mode: "push",
              expression: ["streams", ["get", "/integrations/email"], "acceptCrossPost"],
            },
            deliver: "new",
          },
        }),
      );
    }
    if (
      event === null ||
      state.birthCertificate === null ||
      event.type !== "events.iterate.com/project/human-approval-requested"
    ) {
      return;
    }
    blockProcessorWhile(() =>
      append({
        type: "events.iterate.com/notification/requested",
        idempotencyKey: this.idempotencyKey("approval-requested", event),
        payload: {
          audience: { kind: "project" },
          title: "Approval needed",
          body: `${event.payload.method} ${new URL(event.payload.url).host} is waiting for approval.`,
          destination: {
            kind: "approvals",
            approvalRequestEventOffset: event.offset,
          },
          expiresAt: Date.parse(event.payload.expiresAt),
        },
      }),
    );
  }
}
