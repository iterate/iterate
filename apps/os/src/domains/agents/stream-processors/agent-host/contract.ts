// Defines the "agent-host" processor contract.
//
// The processor observes every event on an agent stream (`consumes: ["*"]`)
// and runs OS-owned host side effects: waking the stream's AgentDurableObject,
// initializing child-agent DOs, and bridging codemode script execution.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { AgentProcessorContract } from "../agent/contract.ts";

export const AGENT_HOST_PROCESSOR_SLUG = "agent-host";

export const AgentHostProcessorContract = defineProcessorContract({
  slug: AGENT_HOST_PROCESSOR_SLUG,
  version: "0.1.0",
  description: "Runs OS-owned host side effects for agent streams.",
  stateSchema: z.object({}),
  initialState: {},
  // Append permission for the codemode-completion agent input rows.
  processorDeps: [AgentProcessorContract],
  events: {},
  consumes: ["*"],
  emits: ["events.iterate.com/agent/input-added"],
});

export type AgentHostState = z.infer<typeof AgentHostProcessorContract.stateSchema>;
