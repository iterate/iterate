import { oc } from "@orpc/contract";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

const HelloInput = z.object({
  name: z.string().trim().min(1).default("world"),
});

const HelloResult = z.object({
  message: z.string(),
});

const FetchExampleInput = z.object({});

const FetchExampleResult = z.object({
  ok: z.boolean(),
  status: z.number(),
  url: z.string().url(),
  body: z.string(),
});

const CreateAgentInput = z.object({
  streamPath: z
    .string()
    .trim()
    .min(1)
    .describe("Events stream path to subscribe (e.g. /my/stream)"),
  publicBaseUrl: z
    .string()
    .trim()
    .url()
    .describe(
      "Public origin events.iterate.com should reach this agents deployment at (e.g. your tunnel URL). Usually window.location.origin in the UI.",
    ),
  projectSlug: z
    .string()
    .trim()
    .min(1)
    .default("public")
    .describe("events.iterate.com project slug"),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Model to use for this agent (e.g. `@cf/moonshotai/kimi-k2.5`, `openai/gpt-5.4`, `anthropic/claude-opus-4.7`). Emits an `llm-config-updated` event when set.",
    ),
  runOpts: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Extra `env.AI.run` options (e.g. `{ gateway: { id: "default" } }`). Ignored unless `model` is also set.',
    ),
  systemPrompt: z
    .string()
    .optional()
    .describe(
      "If set, appended to the stream as an `agent-input-added` event with `role: 'system'` so the agent picks it up before its first user turn.",
    ),
});

const CreateAgentResult = z.object({
  streamPath: z.string(),
  callbackUrl: z.string(),
  streamViewerUrl: z.string(),
  appendUrl: z.string(),
  subscriptionSlug: z.string(),
  agentInstance: z.string(),
  modelApplied: z
    .string()
    .nullable()
    .describe("Model that was pushed via `llm-config-updated`, if any."),
  systemPromptApplied: z
    .boolean()
    .describe("Whether a system-prompt `agent-input-added` event was appended."),
});

export const agentsContract = oc.router({
  __internal: internalContract,
  hello: oc
    .route({
      operationId: "hello",
      method: "POST",
      path: "/hello",
      description: "Return a tiny sample response from the agents app.",
      tags: ["/sample"],
    })
    .input(HelloInput)
    .output(HelloResult),
  fetchExample: oc
    .route({
      operationId: "fetchExample",
      method: "POST",
      path: "/fetch-example",
      description: "Fetch example.com through the worker's outbound egress path.",
      tags: ["/sample"],
    })
    .input(FetchExampleInput)
    .output(FetchExampleResult),
  createAgent: oc
    .route({
      operationId: "createAgent",
      method: "POST",
      path: "/create-agent",
      description:
        "Subscribe an events.iterate.com stream to this deployment's IterateAgent over WebSocket and optionally configure its model, run options, and system prompt before the agent's first turn.",
      tags: ["/sample"],
    })
    .input(CreateAgentInput)
    .output(CreateAgentResult),
});
