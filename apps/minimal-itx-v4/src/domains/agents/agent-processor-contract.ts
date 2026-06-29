import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description: "Tiny faux-agent loop for minimal ITX v4.",
  stateSchema: z.object({
    created: z.boolean().default(false),
    inputs: z
      .array(
        z.object({
          content: z.string(),
          offset: z.number(),
        }),
      )
      .default([]),
    outputs: z
      .array(
        z.object({
          content: z.string(),
          offset: z.number(),
        }),
      )
      .default([]),
    scheduledRequests: z.record(z.string(), z.number()).default({}),
    scriptExecutionsCompleted: z.array(z.string()).default([]),
  }),
  initialState: {
    created: false,
    inputs: [],
    outputs: [],
    scheduledRequests: {},
    scriptExecutionsCompleted: [],
  },
  events: {
    "events.iterate.com/agent/create-requested": {
      description: "An agent creation was requested.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/agent/created": {
      description: "The agent was created.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/agents/user-message-received": {
      description: "The web UI sent a user message to the agent.",
      payloadSchema: z.looseObject({
        content: z.string(),
        origin: z.string(),
      }),
    },
    "events.iterate.com/agent/input-added": {
      description: "A normalized model-visible input was added.",
      payloadSchema: z.looseObject({
        content: z.string(),
        origin: z.string().optional(),
        sourceOffset: z.number().optional(),
      }),
    },
    "events.iterate.com/agent/llm-request-scheduled": {
      description: "A faux LLM request should be requested after a short debounce.",
      payloadSchema: z.looseObject({
        debounceMs: z.number(),
        inputOffset: z.number(),
        requestId: z.string(),
      }),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description: "The faux LLM request is ready to run.",
      payloadSchema: z.looseObject({
        inputOffset: z.number(),
        requestId: z.string(),
      }),
    },
    "events.iterate.com/agent/output-added": {
      description: "The faux LLM produced assistant output, usually codemode.",
      payloadSchema: z.looseObject({
        content: z.string(),
        inputOffset: z.number().optional(),
        requestId: z.string().optional(),
      }),
    },
    "events.iterate.com/agents/web-message-sent": {
      description: "A visible agent message was sent to the web UI.",
      payloadSchema: z.looseObject({
        message: z.string(),
      }),
    },
    "events.iterate.com/itx/script-execution-requested": {
      description: "A codemode block should run in this agent ITX context.",
      payloadSchema: z.looseObject({
        code: z.string(),
        executionId: z.string(),
      }),
    },
    "events.iterate.com/itx/script-execution-completed": {
      description: "A codemode block finished in this agent ITX context.",
      payloadSchema: z.looseObject({
        error: z.string().optional(),
        executionId: z.string(),
        result: z.unknown().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/agent/create-requested",
    "events.iterate.com/agent/created",
    "events.iterate.com/agents/user-message-received",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/itx/script-execution-requested",
  ],
});
