import type { z } from "zod";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import type { SubscriptionConfiguredPayload } from "../streams/core-processor-contract.ts";
import { SchedulerProcessorContract } from "./scheduler-processor-contract.ts";

/** The immutable `scheduler/created` birth certificate payload. */
type SchedulerCreatePayload = z.input<
  (typeof SchedulerProcessorContract.events)["events.iterate.com/scheduler/created"]["payloadSchema"]
>;

/** The complete atomic Scheduler birth batch: certificate plus processor subscription. */
export function schedulerCreationEvents(input: {
  path: string;
  payload?: SchedulerCreatePayload;
  projectId: string;
}) {
  const { path, projectId } = input;
  return [
    SchedulerProcessorContract.buildEvent({
      type: "events.iterate.com/scheduler/created",
      idempotencyKey: `scheduler-created:${projectId}:${path}`,
      payload: input.payload ?? { config: {} },
    }),
    // The scheduler processor deliberately STAYS hosted in its own Durable
    // Object (its domain alarm is entangled with the DO's platform alarm), so
    // its wake keeps the itx expression instead of facet placement.
    CoreProcessorContract.buildEvent({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `stream/subscription-configured:${SchedulerProcessorContract.slug}`,
      payload: {
        name: SchedulerProcessorContract.slug,
        receiver: {
          action: "processor-wake",
          expression: ["schedulers", ["get", path], "processor", "wakeStreamProcessor"],
          processorSlug: SchedulerProcessorContract.slug,
        },
      } satisfies SubscriptionConfiguredPayload,
    }),
  ];
}
