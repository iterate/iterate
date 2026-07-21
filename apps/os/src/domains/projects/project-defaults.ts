import type { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { notificationCreationEvents } from "../notifications/notification-defaults.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

/** The immutable `project/created` birth certificate payload. */
type ProjectCreatePayload = z.input<
  (typeof ProjectProcessorContract.events)["events.iterate.com/project/created"]["payloadSchema"]
>;

/**
 * The complete atomic root-stream birth batch for one project: the project
 * and notification birth certificates plus the subscriptions arming both
 * processors hosted by the Project Durable Object.
 *
 * The created-event keys contain identity only, never payload. Identical
 * retries dedupe; a retry with different birth facts is rejected by the
 * stream's same-key-different-body check.
 */
export function projectCreationEvents(input: { payload: ProjectCreatePayload; projectId: string }) {
  const { payload, projectId } = input;
  const durableObjectName = DurableObjectNameCodec.stringify({ path: "/", projectId });
  return [
    ProjectProcessorContract.buildEvent({
      type: "events.iterate.com/project/created",
      idempotencyKey: `project-created:${projectId}`,
      payload,
    }),
    ...notificationCreationEvents({ projectId }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${ProjectProcessorContract.slug}`,
      processor: ["processor"],
      processorSlug: ProjectProcessorContract.slug,
    }),
  ];
}
