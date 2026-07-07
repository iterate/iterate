// Contract for the "email" thread-router processor mounted on the per-project
// `/integrations/email` stream (tasks/email-agent-zero-onboarding.md).
// Modeled on the Slack router (slack-processor-contract.ts).

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

const EmailAttachmentMetadata = z.object({
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});

/** Wire shape of one inbound email fact — see InboundEmailPayload in inbound.ts. */
export const EmailReceivedPayload = z
  .object({
    projectId: z.string(),
    recipient: z.object({
      kind: z.enum(["zero-onboarding", "project"]),
      address: z.string(),
    }),
    from: z.object({ address: z.string(), name: z.string().optional() }),
    subject: z.string(),
    text: z.string().optional(),
    html: z.string().optional(),
    messageId: z.string(),
    inReplyTo: z.string().optional(),
    references: z.array(z.string()).default([]),
    attachments: z.array(EmailAttachmentMetadata).default([]),
    provisioned: z.boolean().default(false),
  })
  .loose();

/**
 * Processor mounted on `/integrations/email`.
 *
 * This processor is only an email thread router. It owns inbound/outbound
 * email facts and a reduced `Message-ID -> agent stream path` lookup table so
 * every message in one email conversation lands on one stable agent stream.
 *
 * The intended flow is:
 *
 * 1. The email ingress (handleInboundEmail) appends the parsed inbound mail to
 *    `/integrations/email` as `events.iterate.com/email/received`.
 * 2. If the mail references a known thread (`In-Reply-To`/`References` matches
 *    a recorded Message-ID) it routes to that thread's agent path; otherwise
 *    this processor mints `/agents/email/thread-<id>` from the message's own
 *    Message-ID and emits `email/thread-route-configured`.
 * 3. The original email/received event is forwarded verbatim to the routed
 *    agent stream. The `email-agent` processor there does the agent
 *    transcription; the project processor's child-stream-created lane gives
 *    the routed stream its subscriptions (and the email system prompt).
 * 4. Outbound `email/sent` events (appended by EmailRpcTarget with threading
 *    ids) fold their platform-generated Message-ID into the same table, so a
 *    human reply to the bot's reply threads back to the same agent.
 */
export const EmailProcessorContract = defineProcessorContract({
  slug: "email",
  version: "0.1.0",
  description: "Routes inbound project email into email-thread agent streams.",
  stateSchema: z.object({
    /**
     * Durable email-thread routing table.
     *
     * Key: normalized Message-ID (no angle brackets, lowercase).
     * Value: the agent stream path where mail in that thread should land.
     */
    threads: z.record(z.string(), z.string()).default({}),
  }),
  events: {
    "events.iterate.com/email/received": {
      description:
        "One parsed, sender-verified inbound email, appended by the email ingress to `/integrations/email` and forwarded unchanged to routed thread streams.",
      payloadSchema: EmailReceivedPayload,
    },
    "events.iterate.com/email/sent": {
      description:
        "Audit fact for one outbound email sent from the project's address (appended by itx.email.send; bodies stay out of the stream).",
      payloadSchema: z
        .object({
          from: z.string(),
          messageId: z.string().nullable(),
          projectId: z.string(),
          subject: z.string(),
          to: z.union([z.string(), z.array(z.string())]),
          inReplyTo: z.string().optional(),
          references: z.array(z.string()).optional(),
        })
        .loose(),
    },
    "events.iterate.com/email/thread-route-configured": {
      description:
        "Declares that a set of email Message-IDs maps to an agent stream path. The email processor reduces this into its routing table on `/integrations/email`.",
      payloadSchema: z.object({
        messageIds: z.array(z.string()),
        streamPath: z.string(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/email/received",
    "events.iterate.com/email/sent",
    "events.iterate.com/email/thread-route-configured",
  ],
  emits: ["events.iterate.com/email/received", "events.iterate.com/email/thread-route-configured"],
});

export type EmailProcessorState = z.infer<typeof EmailProcessorContract.stateSchema>;
