import { z } from "zod";
import { AgentProcessorContract } from "../agent/contract.ts";
import { CodemodeProcessorContract } from "../codemode/contract.ts";
import { defineProcessorContract } from "../stream-processor.ts";
import { SlackProcessorContract } from "../slack/contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * This processor is deliberately only the Slack-to-agent transcription step.
 * The upstream `slack` router has already decided that the raw Slack webhook
 * belongs on this stream. Once it lands here, we append model-visible agent
 * input or codemode script requests and stop. Slack reactions, status updates,
 * and other Slack API writes are owned by the OS2 runner, not this portable
 * shared processor.
 */
export const SlackThreadProcessorContract = defineProcessorContract({
  slug: "slack-thread",
  version: "0.1.0",
  description: "Transcribes routed Slack webhooks for one Slack-backed agent stream.",
  stateSchema: z.object({}),
  initialState: {},
  processorDeps: [AgentProcessorContract, CodemodeProcessorContract, SlackProcessorContract],
  events: {},
  consumes: ["events.iterate.com/slack/webhook-received"],
  emits: [
    "events.iterate.com/agent/input-added",
    "events.iterate.com/codemode/script-execution-requested",
  ],
});
