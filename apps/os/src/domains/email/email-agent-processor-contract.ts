// The email-agent CONTRACT, for the processor that runs on one routed email
// agent stream (`/agents/email/t<threadId>`). It owns NO event types of its
// own — everything it consumes and emits belongs to the email router
// (email-processor-contract.ts, including this facet's own birth certificate,
// which the ROUTER appends into the creation batch), the agent contract, or
// the core stream contract — so its schemas are reach-throughs into those
// contracts plus a few inline state fields.
//
// The upstream `email` router has already routed inbound mail to this stream.
// This processor owns the email-specific in-thread behavior: recording thread
// identity and transcribing received mail into agent context. Replies leave
// through `itx.email.reply` (rpc-targets.ts), which derives the counterpart,
// threading headers, and the thread's Reply-To tag from this same stream — so
// unlike the slack-agent processor there are no send-side deps here.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";

export const EmailAgentProcessorContract = defineProcessorContract({
  slug: "email-agent",
  version: "0.2.0",
  description: "Handles email-specific behavior for one routed email agent stream.",
  stateSchema: z.object({
    // The router owns the email-agent/created event; its payload schema IS
    // this facet's birth certificate, reached through the router's contract.
    birthCertificate: EmailProcessorContract.events[
      "events.iterate.com/email-agent/created"
    ].payloadSchema
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until email-agent/created reduces. Birth fixes the " +
          "thread identity; nothing is transcribed before it.",
      }),
    threadId: z
      .string()
      .optional()
      .meta({
        description:
          "The email thread this agent stream serves — set at birth, refreshed by " +
          "email/thread-route-configured.",
      }),
    streamPath: z.string().optional().meta({
      description: "This thread's stream path, as the route context declared it.",
    }),
    counterpart: z
      .string()
      .optional()
      .meta({
        description:
          "Who the thread is with: the latest inbound Reply-To/From address. Never the " +
          "project's own address, and never an automated sender (bounces must not become " +
          "the reply target).",
      }),
    subject: z.string().optional().meta({
      description: "The thread's subject: the latest inbound mail's Subject header.",
    }),
  }),
  events: {},
  // CoreProcessorContract brings the platform revival fact into scope (see
  // `consumes`).
  processorDeps: [AgentProcessorContract, EmailProcessorContract, CoreProcessorContract],
  consumes: [
    "events.iterate.com/email-agent/created",
    "events.iterate.com/email/thread-route-configured",
    "events.iterate.com/email/received",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). This contract
    // currently consumes it, but does not react to the fact itself; an
    // unconsumed tail would receive the same eventless at-head turn. Its append
    // cold-boots the Stream DO so an unacknowledged inbound-mail frame
    // redelivers after a simultaneous Agent+Stream DO death. Never emitted by
    // the processor: the recovery adapter appends it raw, as the runtime
    // speaking.
    "events.iterate.com/stream/processor-revived",
  ],
  emits: ["events.iterate.com/agents/context-added", "events.iterate.com/agent/binding-set"],
});
export type EmailAgentProcessorContract = typeof EmailAgentProcessorContract;

export type EmailAgentProcessorState = z.output<typeof EmailAgentProcessorContract.stateSchema>;
