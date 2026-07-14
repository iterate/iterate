// Contract for the "email-agent" processor that runs on one routed email
// agent stream (`/agents/email/t<threadId>`), shaped after the slack-agent
// processor contract. It owns no event types of its own: everything it
// consumes and emits belongs to the email router or the agent contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";

/**
 * Processor for one email-thread agent stream.
 *
 * The upstream `email` router has already routed inbound mail to this stream.
 * This processor owns the email-specific in-thread behavior: recording thread
 * context and transcribing received mail into agent input. Replies leave
 * through `itx.email.reply` (rpc-targets.ts), which derives the counterpart,
 * threading headers, and the thread's Reply-To tag from this same stream — so
 * unlike the slack-agent processor there are no side-effect deps here.
 */
export const EmailAgentProcessorContract = defineProcessorContract({
  slug: "email-agent",
  version: "0.1.0",
  description: "Handles email-specific behavior for one routed email agent stream.",
  stateSchema: z.object({
    threadId: z.string().optional(),
    streamPath: z.string().optional(),
    /** Who the thread is with: the latest inbound Reply-To/From address. */
    counterpart: z.string().optional(),
    subject: z.string().optional(),
  }),
  events: {},
  processorDeps: [AgentProcessorContract, EmailProcessorContract],
  consumes: [
    "events.iterate.com/email/thread-route-configured",
    "events.iterate.com/email/received",
  ],
  emits: ["events.iterate.com/agents/message-received", "events.iterate.com/agent/status-changed"],
});

export type EmailAgentProcessorState = z.infer<typeof EmailAgentProcessorContract.stateSchema>;
