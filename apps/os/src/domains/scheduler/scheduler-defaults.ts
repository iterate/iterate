import type { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
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
  const durableObjectName = DurableObjectNameCodec.stringify({ path, projectId });
  return [
    SchedulerProcessorContract.buildEvent({
      type: "events.iterate.com/scheduler/created",
      idempotencyKey: `scheduler-created:${projectId}:${path}`,
      payload: input.payload ?? { config: {} },
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${SchedulerProcessorContract.slug}`,
      processor: ["schedulers", ["get", path], "processor"],
      processorSlug: SchedulerProcessorContract.slug,
    }),
  ];
}
