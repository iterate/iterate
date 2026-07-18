// Contract for the "email-agent" processor that runs on one routed email
// agent stream (`/agents/email/t<threadId>`), shaped after the slack-agent
// processor contract. It owns no event types of its own — everything it
// consumes and emits belongs to the email router, the agent contracts, or the
// core stream contract (the platform revival fact).

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { EmailAgentBirthCertificate, EmailProcessorContract } from "./email-processor-contract.ts";

/**
 * Processor for one email-thread agent stream.
 *
 * The upstream `email` router has already routed inbound mail to this stream.
 * This processor owns the email-specific in-thread behavior: recording thread
 * context and transcribing received mail into agent context. Replies leave
 * through `itx.email.reply` (rpc-targets.ts), which derives the counterpart,
 * threading headers, and the thread's Reply-To tag from this same stream — so
 * unlike the slack-agent processor there are no side-effect deps here.
 */
export const EmailAgentProcessorContract = defineProcessorContract({
  slug: "email-agent",
  version: "0.2.0",
  description: "Handles email-specific behavior for one routed email agent stream.",
  stateSchema: z.object({
    birthCertificate: EmailAgentBirthCertificate.nullable().default(null),
    threadId: z.string().optional(),
    streamPath: z.string().optional(),
    /** Who the thread is with: the latest inbound Reply-To/From address. */
    counterpart: z.string().optional(),
    subject: z.string().optional(),
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
    // processor; the payload's processorSlug names which). MUST be consumed
    // (the runner throws at construction otherwise): appended when an
    // incarnation died owing work — a blocking inbound-mail transcription lost
    // to a simultaneous Agent+Stream DO death — the append cold-boots the
    // Stream DO so the unacknowledged frame redelivers and the blocking
    // transcription re-runs. Never emitted by the processor: the recovery
    // adapter appends it raw, as the runtime speaking.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: ["events.iterate.com/agents/context-added", "events.iterate.com/agent/binding-set"],
});

export type EmailAgentProcessorState = z.infer<typeof EmailAgentProcessorContract.stateSchema>;
