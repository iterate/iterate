// The email thread-router CONTRACT, for the processor mounted on the
// per-project `/integrations/email` stream. Self-contained: state schema,
// events, consumes/emits, deps — and it OWNS the whole email event vocabulary
// (including the email-agent facet's birth certificate, which the router
// appends into each thread stream's creation batch); consumers reach into
// this module for pieces, never the other way around. Schemas are spelled
// INLINE in the contract; the ONE schema it uses twice (the router's own
// birth certificate: the state slot and the email/created payload) is a
// hoisted function below the contract, so the contract still opens the file.
//
// The router owns raw inbound email facts and a reduced thread lookup table;
// it never interprets mail as agent context (the `email-agent` processor on
// the routed stream does that — email-agent-processor-contract.ts).

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const EmailProcessorContract = defineProcessorContract({
  slug: "email",
  version: "0.1.0",
  description: "Routes inbound project email into per-thread email agent streams.",
  stateSchema: z.object({
    birthCertificate: emailRouterBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until email/created reduces. Project creation appends the " +
          "birth; the router forwards no mail before it.",
      }),
    threads: z
      .record(z.string(), z.string())
      .default({})
      .meta({
        description:
          "threadId -> agent stream path for every known email thread. Inbound thread ids are " +
          "the received event's offset on this stream; agent-initiated conversations " +
          "(itx.email.send) register their minted id and the calling agent's own path here " +
          "via email/thread-route-configured.",
      }),
    threadByMessageId: z
      .record(z.string(), z.string())
      .default({})
      .meta({
        description:
          "Normalized RFC 5322 Message-ID -> threadId, for inbound AND outbound mail, so " +
          "replies land in their thread via In-Reply-To/References even when the +t reply " +
          "tag did not survive the mail client.",
      }),
    allowedSenders: z
      .array(z.string())
      .default([])
      .meta({
        description:
          "Per-project inbound sender allowlist (exact addresses or `*@domain`, lowercased), " +
          "checked by the ingress door IN ADDITION to the deployment-wide config allowlist. " +
          "Seeded with the project creator's email at project birth; grown by " +
          "email/sender-allowed events.",
      }),
  }),
  events: {
    "events.iterate.com/email/created": {
      description:
        "Birth certificate for this email router processor. Appended once by project " +
        "creation; the router routes no mail before it reduces.",
      payloadSchema: emailRouterBirthCertificateSchema(),
    },
    "events.iterate.com/email-agent/created": {
      description:
        "Birth certificate for the email facet on one routed agent stream. Owned by the " +
        "router because the router appends it (inside the thread stream's creation batch); " +
        "the email-agent processor reduces it as its existence marker.",
      payloadSchema: z.object({
        config: z
          .object({
            threadId: z
              .string()
              .meta({ description: "The email thread this agent stream serves." }),
            counterpart: z.string().optional().meta({
              description: "Reply target at birth: the first inbound mail's Reply-To/From address.",
            }),
            subject: z.string().optional().meta({ description: "The thread's subject at birth." }),
          })
          .meta({ description: "Thread identity fixed at the facet's birth." }),
      }),
    },
    "events.iterate.com/email/received": {
      description:
        "One parsed inbound email, appended by the worker email() handler (email-ingress.ts) " +
        "to `/integrations/email` and forwarded unchanged by the router to the resolved " +
        "thread's agent stream.",
      // Loose on purpose, throughout: the ingress parser may grow fields
      // without a contract version bump.
      payloadSchema: z
        .object({
          envelope: z
            .object({
              from: z.string().meta({
                description: "SMTP MAIL FROM — the sender address the ingress door authenticated.",
              }),
              to: z.string().meta({
                description:
                  "SMTP RCPT TO — the project address (possibly +t-tagged) the mail arrived on.",
              }),
            })
            .loose()
            .meta({ description: "SMTP envelope, as Cloudflare Email Routing delivered it." }),
          recipient: z
            .object({
              slug: z.string().meta({
                description: "The addressed project's slug (the local part before any + tag).",
              }),
              threadId: z
                .string()
                .nullable()
                .meta({
                  description:
                    "Thread id parsed from a `+t<threadId>` recipient tag; null when untagged " +
                    "or the tag grammar did not match.",
                }),
            })
            .loose()
            .meta({
              description: "Parsed recipient: which project inbox / thread tag the mail addressed.",
            }),
          message: z
            .object({
              messageId: z.string().nullish().meta({
                description: "Normalized RFC 5322 Message-ID, when the mail carried one.",
              }),
              inReplyTo: z.string().nullish().meta({
                description: "Normalized In-Reply-To message id, when present.",
              }),
              references: z.array(z.string()).default([]).meta({
                description: "Normalized References message ids, oldest first.",
              }),
              from: z
                .object({
                  address: z.string().optional().meta({
                    description: "Header From mailbox address, when MIME parsing found one.",
                  }),
                  name: z.string().optional().meta({ description: "Header From display name." }),
                })
                .loose()
                .meta({ description: "Header From, as parsed from the MIME." }),
              replyToAddress: z.string().nullish().meta({
                description: "Header Reply-To address — the preferred reply target when present.",
              }),
              subject: z.string().optional().meta({ description: "Subject header." }),
              text: z.string().optional().meta({
                description: "Plain-text body, truncated at the door (EMAIL_BODY_TRUNCATE_CHARS).",
              }),
              html: z
                .string()
                .optional()
                .meta({ description: "HTML body, truncated at the door." }),
              attachments: z
                .array(
                  z
                    .object({
                      filename: z
                        .string()
                        .nullish()
                        .meta({ description: "Original attachment filename." }),
                      mimeType: z.string().nullish().meta({ description: "Attachment MIME type." }),
                      size: z
                        .number()
                        .optional()
                        .meta({ description: "Attachment size in bytes." }),
                      path: z
                        .string()
                        .optional()
                        .meta({
                          description:
                            "Project file path where the door stored the bytes; absent when " +
                            "storage failed (metadata-only degrade).",
                        }),
                    })
                    .loose(),
                )
                .default([])
                .meta({
                  description:
                    "Attachment descriptors; the bytes live in project file storage at `path`.",
                }),
            })
            .loose()
            .meta({
              description: "Parsed MIME content (bodies truncated at the door; see utils.ts).",
            }),
          projectId: z.string().meta({ description: "The addressed project's id." }),
          automated: z
            .boolean()
            .default(false)
            .meta({
              description:
                "Auto-Submitted / Precedence: bulk / mailer-daemon senders — recorded so " +
                "downstream processors never auto-respond to automated mail.",
            }),
        })
        .loose()
        .meta({ description: "One parsed inbound email as the ingress door captures it." }),
    },
    "events.iterate.com/email/rejected": {
      description:
        "An inbound email the door refused (sender not allowlisted, DMARC fail, unknown " +
        "recipient, oversize). Envelope-sized on purpose: the project can see someone " +
        "knocked, but rejected bodies are never stored.",
      payloadSchema: z
        .object({
          envelope: z
            .object({
              from: z.string().meta({ description: "SMTP MAIL FROM of the rejected message." }),
              to: z.string().meta({ description: "SMTP RCPT TO the message addressed." }),
            })
            .loose()
            .meta({ description: "SMTP envelope of the rejected message." }),
          reason: z.string().meta({
            description:
              'Why the door refused, e.g. "sender-not-allowed", "dmarc-fail", ' +
              '"message-too-large".',
          }),
          projectId: z.string().meta({ description: "The addressed project's id." }),
        })
        .loose()
        .meta({ description: "Envelope-sized audit fact for one refused inbound email." }),
    },
    "events.iterate.com/email/sent": {
      description:
        "Audit fact for one outbound email sent through itx.email (recipients + subject; " +
        "bodies stay out of the stream). Threaded sends carry threadId so the router can " +
        "index the outbound messageId — replies to what the agent sent then route back to " +
        "the thread even without the +t tag.",
      payloadSchema: z
        .object({
          from: z.string().meta({ description: "The project's sending address." }),
          messageId: z.string().nullable().meta({
            description: "Outbound RFC 5322 Message-ID; null when the send reported none.",
          }),
          projectId: z.string().meta({ description: "The sending project's id." }),
          subject: z.string().meta({ description: "Subject line of the outbound mail." }),
          to: z
            .union([z.string(), z.array(z.string())])
            .meta({ description: "Recipient address(es)." }),
          threadId: z
            .string()
            .optional()
            .meta({
              description:
                "The email thread this send belongs to, when threaded; the router indexes " +
                "the outbound messageId under it.",
            }),
          inReplyTo: z.string().optional().meta({
            description: "The inbound message id this send replied to, when it was a reply.",
          }),
        })
        .loose()
        .meta({ description: "One outbound email's audit trail entry." }),
    },
    "events.iterate.com/email/sender-allowed": {
      description:
        "Adds one pattern (exact address or `*@domain`) to the project's inbound sender " +
        "allowlist. Seeded with the project creator's email at project birth.",
      payloadSchema: z.object({
        pattern: z.string().meta({
          description:
            "Exact address (`jonas@example.com`) or whole domain (`*@example.com`); " +
            "matched case-insensitively.",
        }),
        reason: z
          .string()
          .optional()
          .meta({ description: "Why the pattern was added (audit note)." }),
      }),
    },
    "events.iterate.com/email/thread-route-configured": {
      description:
        "Declares that an email thread id maps to a stream path. The router reduces this " +
        "into its routing table on `/integrations/email`; the routed stream receives a copy " +
        "as thread context. Agent-scoped itx.email.send appends it with the calling agent's " +
        "OWN path, binding an agent-initiated conversation to that agent.",
      payloadSchema: z.object({
        threadId: z.string().meta({
          description:
            "Thread id: a received event's offset for inbound threads, a minted `a…` id " +
            "for agent-initiated ones.",
        }),
        streamPath: z.string().meta({
          description:
            "The stream this thread's mail forwards to (`/agents/email/t<threadId>`, or the " +
            "initiating agent's own path).",
        }),
        counterpart: z.string().optional().meta({
          description: "Reply target when the route was created: the thread's human address.",
        }),
        subject: z
          .string()
          .optional()
          .meta({ description: "The thread's subject when the route was created." }),
      }),
    },
  },
  consumes: [
    "events.iterate.com/email/created",
    "events.iterate.com/email/received",
    "events.iterate.com/email/sender-allowed",
    "events.iterate.com/email/sent",
    "events.iterate.com/email/thread-route-configured",
  ],
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, CoreProcessorContract],
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
    "events.iterate.com/stream/subscription-configured",
  ],
});
export type EmailProcessorContract = typeof EmailProcessorContract;

/** Reduced project email-routing state exposed through the processor capability. */
export type EmailProcessorState = z.output<typeof EmailProcessorContract.stateSchema>;

/** One parsed inbound email, as the `email/received` payload schema outputs it. */
export type InboundEmailPayload = z.output<
  (typeof EmailProcessorContract.events)["events.iterate.com/email/received"]["payloadSchema"]
>;

/**
 * The router's birth certificate — the ONE schema the contract uses twice
 * (the state's `birthCertificate` slot and the `email/created` payload), so it
 * lives in this hoisted function instead of inline.
 */
function emailRouterBirthCertificateSchema() {
  return z
    .object({
      config: z.object({}).meta({ description: "Reserved; the router has no birth-time knobs." }),
    })
    .meta({ description: "The email router's birth certificate." });
}
