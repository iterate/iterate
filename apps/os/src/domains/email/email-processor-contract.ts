// Contract for the "email" thread-router processor mounted on the per-project
// `/integrations/email` stream. Deliberately shaped after the Slack webhook
// router (slack-processor-contract.ts): the router owns raw inbound email
// events and a reduced thread lookup table; it does not interpret mail as
// agent context (the `email-agent` processor on the routed stream does that).

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { NotificationIntentContract } from "../notifications/notification-intent-contract.ts";
import { NotificationRequest } from "../notifications/types.ts";

const EmailBirthCertificate = z.object({
  config: z.object({}),
});

export const EmailAgentBirthCertificate = z.object({
  config: z.object({
    threadId: z.string(),
    counterpart: z.string().optional(),
    subject: z.string().optional(),
  }),
});
export type EmailAgentBirthCertificate = z.output<typeof EmailAgentBirthCertificate>;

/** One parsed inbound email as the ingress door captures it. Loose on purpose:
 * the ingress parser may grow fields without a contract version bump. */
const InboundEmailPayload = z
  .object({
    /** SMTP envelope, as Cloudflare Email Routing delivered it. */
    envelope: z.object({ from: z.string(), to: z.string() }).loose(),
    /** Parsed recipient: which project inbox / thread tag the mail addressed. */
    recipient: z.object({ slug: z.string(), threadId: z.string().nullable() }).loose(),
    /** Parsed MIME content (bodies truncated at the door; see utils.ts). */
    message: z
      .object({
        messageId: z.string().nullish(),
        inReplyTo: z.string().nullish(),
        references: z.array(z.string()).default([]),
        from: z.object({ address: z.string().optional(), name: z.string().optional() }).loose(),
        replyToAddress: z.string().nullish(),
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        attachments: z
          .array(
            z
              .object({
                filename: z.string().nullish(),
                mimeType: z.string().nullish(),
                size: z.number().optional(),
                /** Project file path where the door stored the bytes; absent
                 * when storage failed (metadata-only degrade). */
                path: z.string().optional(),
              })
              .loose(),
          )
          .default([]),
      })
      .loose(),
    projectId: z.string(),
    /** Auto-Submitted / Precedence: bulk / mailer-daemon senders — recorded so
     * downstream processors never auto-respond to automated mail. */
    automated: z.boolean().default(false),
  })
  .loose();

export type InboundEmailPayload = z.infer<typeof InboundEmailPayload>;

/**
 * Processor mounted on `/integrations/email`.
 *
 * The intended flow is:
 *
 * 1. The worker's `email()` handler (email-ingress.ts) parses inbound mail and
 *    appends it verbatim-ish to `/integrations/email` as `email/received`
 *    (rejected mail leaves only an envelope-sized `email/rejected` fact).
 * 2. This processor resolves the email thread — recipient `+t<id>` tag first,
 *    then In-Reply-To/References against its message-id index, else a new
 *    thread whose id is the received event's offset — emitting
 *    `email/thread-route-configured` for new threads.
 * 3. It forwards the received event unchanged to the thread's agent stream
 *    (`/agents/email/t<threadId>`). The router explicitly creates the Agent,
 *    CapabilityHost, and email facet and installs all three subscriptions
 *    before forwarding the received event.
 *
 * Outbound mail is indexed too: `email/sent` audit events carrying a
 * `threadId` fold their messageId into the same index, so replies to what the
 * agent sent route back to the thread even without the `+t` tag.
 */
export const EmailProcessorContract = defineProcessorContract({
  slug: "email",
  version: "0.1.0",
  description: "Routes inbound project email into per-thread email agent streams.",
  stateSchema: z.object({
    birthCertificate: EmailBirthCertificate.nullable().default(null),
    /** threadId -> agent stream path for every known email thread. */
    threads: z.record(z.string(), z.string()).default({}),
    /** Normalized RFC 5322 Message-ID -> threadId, for inbound AND outbound
     * mail, so replies land in their thread via In-Reply-To/References. */
    threadByMessageId: z.record(z.string(), z.string()).default({}),
    /**
     * Per-project sender allowlist (exact addresses or `*@domain`), checked by
     * the ingress door IN ADDITION to the deployment-wide config allowlist.
     * Seeded with the project creator's email at birth; grown by appending
     * `email/sender-allowed` events.
     */
    allowedSenders: z.array(z.string()).default([]),
    notificationRecipients: z.array(z.string().email()).default([]),
    notifications: z
      .record(z.string(), NotificationRequest.extend({ status: z.enum(["requested", "started"]) }))
      .default({}),
  }),
  events: {
    "events.iterate.com/email/created": {
      description: "Birth certificate for this email router processor.",
      payloadSchema: EmailBirthCertificate,
    },
    "events.iterate.com/email-agent/created": {
      description: "Birth certificate for the email facet on an agent stream.",
      payloadSchema: EmailAgentBirthCertificate,
    },
    "events.iterate.com/email/received": {
      description:
        "One parsed inbound email, appended by the worker email() handler to `/integrations/email` and forwarded unchanged to the routed thread stream.",
      payloadSchema: InboundEmailPayload,
    },
    "events.iterate.com/email/rejected": {
      description:
        "An inbound email the door refused (sender not allowlisted, DMARC fail, unknown recipient, oversize). Envelope-sized: no bodies.",
      payloadSchema: z
        .object({
          envelope: z.object({ from: z.string(), to: z.string() }).loose(),
          reason: z.string(),
          projectId: z.string(),
        })
        .loose(),
    },
    "events.iterate.com/email/sent": {
      description:
        "Audit fact for one outbound email sent through itx.email (recipients + subject; bodies stay out of the stream). Threaded replies carry threadId so the router can index the outbound messageId.",
      payloadSchema: z
        .object({
          from: z.string(),
          messageId: z.string().nullable(),
          projectId: z.string(),
          subject: z.string(),
          to: z.union([z.string(), z.array(z.string())]),
          threadId: z.string().optional(),
          inReplyTo: z.string().optional(),
        })
        .loose(),
    },
    "events.iterate.com/email/sender-allowed": {
      description:
        "Adds one pattern (exact address or `*@domain`) to the project's inbound sender allowlist. Seeded with the project creator's email at project birth.",
      payloadSchema: z.object({
        pattern: z.string(),
        reason: z.string().optional(),
      }),
    },
    "events.iterate.com/email/notification-recipient-configured": {
      description: "Configures one address that receives project-audience email notifications.",
      payloadSchema: z.object({
        email: z.string().email(),
        reason: z.literal("project-owner"),
      }),
    },
    "events.iterate.com/email/notification-attempt-started": {
      description: "Durable evidence written before sending one notification email.",
      payloadSchema: z.object({ requestOffset: z.number().int().positive() }),
    },
    "events.iterate.com/email/notification-settled": {
      description: "Closes one email notification obligation without ambiguous retry.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        outcome: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("sent"), messageId: z.string().nullable() }),
          z.object({ kind: z.literal("expired") }),
          z.object({ kind: z.literal("recipient-unavailable") }),
          z.object({ kind: z.literal("uncertain"), reason: z.string().min(1) }),
        ]),
      }),
    },
    "events.iterate.com/email/thread-route-configured": {
      description:
        "Declares that an email thread id maps to a stream path. The email processor reduces this into its routing table on `/integrations/email`; the routed stream receives a copy as thread context.",
      payloadSchema: z.object({
        threadId: z.string(),
        streamPath: z.string(),
        counterpart: z.string().optional(),
        subject: z.string().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/email/created",
    "events.iterate.com/email/received",
    "events.iterate.com/email/sender-allowed",
    "events.iterate.com/email/sent",
    "events.iterate.com/email/thread-route-configured",
    "events.iterate.com/email/notification-recipient-configured",
    "events.iterate.com/email/notification-attempt-started",
    "events.iterate.com/email/notification-settled",
    "events.iterate.com/notification/requested",
  ],
  processorDeps: [
    AgentProcessorContract,
    CapabilityHostProcessorContract,
    CoreProcessorContract,
    NotificationIntentContract,
  ],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/binding-set",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/email-agent/created",
    "events.iterate.com/email/thread-route-configured",
    "events.iterate.com/email/received",
    "events.iterate.com/email/sent",
    "events.iterate.com/email/notification-attempt-started",
    "events.iterate.com/email/notification-settled",
    "events.iterate.com/stream/subscription-configured",
  ],
});

export type EmailProcessorState = z.infer<typeof EmailProcessorContract.stateSchema>;
