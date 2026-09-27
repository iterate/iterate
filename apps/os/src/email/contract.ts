// src/email/contract.ts — EMAIL: a project's mail, at `<slug>@<email domain>` (`<slug>@iterate.app`
// on prd). Every message in or out lands on ONE context of the project, `/integrations/email`:
// inbound mail from Cloudflare Email Routing through the worker's `email()` handler as
// `email/received`, and each `itx.email.send` as `email/sent`, both appended by the platform
// (integrations/email.ts). processor.ts folds them into threads by Message-ID, In-Reply-To and
// References;
// durable-object.ts hosts it as the first-party facet `email` on that context. An attachment's bytes
// are a project file (`itx.files.get(path)`), under `/email/`.
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";
import type { IngressRouting } from "iterate/project-ingress";

/** The context every message of a project lands on, and the `email` facet folds. */
export const EMAIL_PATH = "/integrations/email";

/** The domain a project's mail is on: the hostname the project wildcard is on (`iterate.app` on
 *  prd). Null where projects are paths on the platform's origin (a preview, a self-host without a
 *  wildcard): no project has an address there. */
export function emailDomainOf(ingressRouting: IngressRouting) {
  return ingressRouting?.type === "subdomains" ? ingressRouting.hostname : null;
}

/** One message as both directions record it. Message ids are bare (no angle brackets). */
const EmailMessage = z.object({
  /** Its RFC 5322 Message-ID; null when an inbound message carried none. */
  messageId: z.string().nullable(),
  /** The author's address. */
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  /** The bodies, each cut at 100,000 characters (integrations/email.ts); null when absent — a
   *  stored event keeps no undefined key, and a redelivery's body must equal it. */
  text: z.string().nullable(),
  html: z.string().nullable(),
  /** The message it answers, and its thread's ids oldest first: what threads it (processor.ts). */
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  /** Each attachment's bytes are the project file at `path`. */
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
      path: z.string(),
    }),
  ),
});

export const EmailContract = defineProcessorContract({
  slug: "email",
  version: "1",
  description: "A project's email, both directions, folded into threads.",
  stateSchema: z.object({
    /** Every thread, keyed by the offset of its first message: that message's subject and the
     *  offset of every message in it, oldest first. */
    threads: z
      .record(z.string(), z.object({ subject: z.string(), messageOffsets: z.array(z.number()) }))
      .default({}),
    /** Each message's Message-ID → the offset of its thread's first message: how a reply finds
     *  its thread. */
    threadOffsetByMessageId: z.record(z.string(), z.number()).default({}),
  }),
  events: {
    "events.iterate.com/email/received": {
      description:
        "A message arrived at one of the project's addresses (platform fact, keyed by its Message-ID).",
      payloadSchema: EmailMessage.extend({
        /** Where the author asks for replies (Reply-To), when it is not `from`. */
        replyTo: z.string().optional(),
        /** The SMTP envelope: the sending server's MAIL FROM, and the address it was delivered to
         *  (`<slug>@…`, or `<slug>+<tag>@…`). */
        envelope: z.object({ from: z.string(), to: z.string() }),
      }),
    },
    "events.iterate.com/email/sent": {
      description: "The project sent a message through `itx.email.send` (platform fact).",
      payloadSchema: EmailMessage,
    },
  },
  consumes: ["events.iterate.com/email/received", "events.iterate.com/email/sent"],
  emits: [],
});

/** The reduced threads (the contract's `stateSchema`). */
export type EmailState = ProcessorState<typeof EmailContract>;
