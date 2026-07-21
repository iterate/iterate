import type { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";
import { EMAIL_INTEGRATION_STREAM_PATH } from "./utils.ts";

/** The immutable `email/created` router birth certificate payload. */
type EmailRouterCreatePayload = z.input<
  (typeof EmailProcessorContract.events)["events.iterate.com/email/created"]["payloadSchema"]
>;

/**
 * The complete atomic email-router birth batch. The optional initial sender
 * is a project default and therefore lands in the same commit as the birth
 * certificates and processor subscription.
 */
export function emailRouterCreationEvents(input: {
  initialSender?: string;
  payload?: EmailRouterCreatePayload;
  projectId: string;
}) {
  const { initialSender, projectId } = input;
  const path = EMAIL_INTEGRATION_STREAM_PATH;
  const durableObjectName = DurableObjectNameCodec.stringify({ path, projectId });
  return [
    EmailProcessorContract.buildEvent({
      type: "events.iterate.com/email/created",
      idempotencyKey: `email-created:${projectId}`,
      payload: input.payload ?? { config: {} },
    }),
    ...(initialSender === undefined
      ? []
      : [
          EmailProcessorContract.buildEvent({
            type: "events.iterate.com/email/sender-allowed",
            idempotencyKey: `email-sender-allowed:${projectId}:${initialSender.toLowerCase()}`,
            payload: { pattern: initialSender, reason: "project-owner" },
          }),
        ]),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${EmailProcessorContract.slug}`,
      processor: ["email", "processor"],
      processorSlug: EmailProcessorContract.slug,
    }),
  ];
}
