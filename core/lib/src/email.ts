// email.ts — EMAIL's events and threads: a project's mail, every message in or out on one context,
// `/integrations/email` (core/os src/email/contract.ts), inbound as `email/received` and each
// `itx.email.send` as `email/sent`, both appended by the platform (core/os integrations/email.ts).
// The first-party `email` facet there folds them into threads (core/os email/processor.ts); a config
// repo reads its state and parses a message with this contract (configs/default/worker.ts).
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "./stream/processor.ts";

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
        /** Who sent it, as far as the platform can tell (email/sender.ts). */
        sender: z.object({
          /** The From address is proven by Cloudflare's checks as it received the message: an
           *  aligned DMARC pass, DKIM signature or SPF pass. A forged From is false. */
          verified: z.boolean(),
          /** The From address is verified and belongs to a member of this project. */
          member: z.boolean(),
          /** The From domain's own server handed the message over: every Cloudflare record has an
           *  SPF pass for an aligned envelope domain (email/sender.ts). Anyone can re-send a
           *  message a member once sent, DKIM signature intact, so only a direct message is the
           *  member speaking now; a forward or a list's copy is not direct. */
          direct: z.boolean(),
        }),
        /** An auto-reply, a bulk or list message, or a bounce: nothing should answer it
         *  automatically. */
        automated: z.boolean(),
        /** Cloudflare's SPF, DKIM and DMARC verdicts as it received the message (`pass`, `fail`,
         *  `none`, …), null where it gave none. */
        authentication: z.object({
          spf: z.string().nullable(),
          dkim: z.string().nullable(),
          dmarc: z.string().nullable(),
        }),
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
