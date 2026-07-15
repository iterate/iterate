// Contract for the "email-agent" processor that runs on one routed email
// agent stream (`/agents/email/t<threadId>`), shaped after the slack-agent
// processor contract. It owns exactly one event type of its own — the
// platform-appended revival fact below; everything else it consumes and emits
// belongs to the email router or the agent contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";

/**
 * The processor-scoped revival fact `durableObjectRecovery` appends when an
 * incarnation died owing work (stream-processor-runner.ts's
 * `ProcessorRecovery`) — here, the blocking transcription of inbound mail
 * (attachment resolution + the `agents/message-received` append) under
 * `blockProcessorWhile`. The held cursor alone is not enough: a SIMULTANEOUS
 * Agent+Stream DO death (a deploy evicts both) leaves nothing armed to dial
 * either side again, so a quiet inbox message strands untranscribed. The
 * keepalive alarm survives that death; its revival appends this fact, which
 * cold-boots the Stream DO (the append's `woken` fan-out restores the spine),
 * and the ordinary redelivery of the UNACKNOWLEDGED frame re-runs the
 * blocking transcription. The contract CONSUMES it — the runner's
 * construction check requires that — but never emits it: the recovery adapter
 * appends it raw, as the runtime speaking. The fact itself is only a wake
 * trigger; no per-event handling is needed (reduce ignores it).
 */
export const EMAIL_AGENT_REVIVED_EVENT_TYPE = "events.iterate.com/email-agent/revived";

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
  events: {
    [EMAIL_AGENT_REVIVED_EVENT_TYPE]: {
      description:
        "The email-agent processor was revived after its incarnation died owing work (an inbound-mail transcription in flight when an eviction took both the agent and stream DOs). Appended by the platform's recovery alarm, not by the processor; the append cold-boots the stream so the unacknowledged frame redelivers and the blocking transcription re-runs.",
      // Loose ON PURPOSE: the payload is authored by the shared recovery
      // adapter (durableObjectRecovery.appendRevived), and future fields it
      // grows must not turn historical revivals into parse failures.
      payloadSchema: z.looseObject({
        processorSlug: z.string(),
        revivals: z.number(),
        version: z.string(),
      }),
      examples: [
        {
          description:
            "The keepalive alarm revived this thread's email-agent after an eviction took its in-flight transcription.",
          payload: { processorSlug: "email-agent", revivals: 1, version: "2026-07-15.1" },
        },
      ],
    },
  },
  processorDeps: [AgentProcessorContract, EmailProcessorContract],
  consumes: [
    "events.iterate.com/email/thread-route-configured",
    "events.iterate.com/email/received",
    // The revival fact MUST be consumed (the runner throws at construction
    // otherwise): a revival nobody consumes recovers nothing. See the
    // constant's doc for why it is absent from `emits`.
    EMAIL_AGENT_REVIVED_EVENT_TYPE,
  ],
  emits: ["events.iterate.com/agents/message-received"],
});

export type EmailAgentProcessorState = z.infer<typeof EmailAgentProcessorContract.stateSchema>;
