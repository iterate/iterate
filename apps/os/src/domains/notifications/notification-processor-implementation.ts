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
          body: `${event.payload.method} ${approvalRequestHost(event.payload.url)} is waiting for approval.`,
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

function approvalRequestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
