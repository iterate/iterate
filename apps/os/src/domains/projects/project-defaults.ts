import type { z } from "zod";
import { notificationCreationEvents } from "../notifications/notification-defaults.ts";
import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

/** The immutable `project/create-requested` creation intent. */
type ProjectCreatePayload = z.input<
  (typeof ProjectProcessorContract.events)["events.iterate.com/project/create-requested"]["payloadSchema"]
>;

/**
 * The complete atomic root-stream creation-request batch for one project: the
 * project intent, notification birth certificate, and subscriptions arming
 * both processors hosted by the Project Durable Object.
 *
 * The creation-event keys contain identity only, never payload. Identical
 * retries dedupe; a retry with different birth facts is rejected by the
 * stream's same-key-different-body check.
 */
export function projectCreationEvents(input: { payload: ProjectCreatePayload; projectId: string }) {
  const { payload, projectId } = input;
  return [
    ProjectProcessorContract.buildEvent({
      type: "events.iterate.com/project/create-requested",
      idempotencyKey: `project-create-requested:${projectId}`,
      payload,
    }),
    ...notificationCreationEvents({ projectId }),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${ProjectProcessorContract.slug}`,
      name: ProjectProcessorContract.slug,
    }),
  ];
}
