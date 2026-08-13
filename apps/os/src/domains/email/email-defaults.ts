import type { z } from "zod";
import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";

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
  return [
    EmailProcessorContract.buildEvent({
      type: "events.iterate.com/email/created",
      idempotencyKey: `email-created:${projectId}`,
      payload: input.payload ?? { config: {} },
    }),
    ...(!initialSender
      ? []
      : [
          EmailProcessorContract.buildEvent({
            type: "events.iterate.com/email/sender-allowed",
            idempotencyKey: `email-sender-allowed:${projectId}:${initialSender.toLowerCase()}`,
            payload: { pattern: initialSender, reason: "project-owner" },
          }),
        ]),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${EmailProcessorContract.slug}`,
      name: EmailProcessorContract.slug,
    }),
  ];
}
