// Contract for the "email-agent" processor that runs on one routed email
// thread agent stream (`/agents/email/thread-<id>`) —
// tasks/email-agent-zero-onboarding.md. Modeled on slack-agent-processor-contract.ts.
// It owns no event types of its own: everything it consumes and emits belongs
// to the email router or the agent processor contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";

/**
 * Processor for one email-thread-backed agent stream.
 *
 * The upstream `email` router has already forwarded inbound mail to this
 * stream. This processor owns the email-specific in-thread behavior:
 * transcribing each inbound email into agent input and tracking the reply
 * context (sender, subject, threading ids) the agent needs to answer with
 * `itx.email.send`.
 */
export const EmailAgentProcessorContract = defineProcessorContract({
  slug: "email-agent",
  version: "0.1.0",
  description: "Handles email-specific behavior for one routed email-thread agent stream.",
  stateSchema: z.object({
    senderAddress: z.string().optional(),
    senderName: z.string().optional(),
    subject: z.string().optional(),
    /** Message-ID of the most recent inbound mail (what a reply answers). */
    lastInboundMessageId: z.string().optional(),
    /** Thread ancestry for the next reply's References header, oldest first. */
    references: z.array(z.string()).default([]),
  }),
  events: {},
  processorDeps: [AgentProcessorContract, EmailProcessorContract],
  consumes: ["events.iterate.com/email/received"],
  emits: ["events.iterate.com/agent/input-added"],
});

export type EmailAgentProcessorState = z.infer<typeof EmailAgentProcessorContract.stateSchema>;
