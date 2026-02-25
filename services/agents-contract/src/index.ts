import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

export const Agent = z.object({
  path: z.string(),
  destination: z.string().nullable(),
  isWorking: z.boolean(),
  shortStatus: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GetOrCreateAgentInput = z.object({
  agentPath: z.string().min(1),
});

export const UpdateAgentInput = z.object({
  path: z.string().min(1),
  destination: z.string().nullable().optional(),
  isWorking: z.boolean().optional(),
  shortStatus: z.string().optional(),
});

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Agents service health metadata",
  sqlSummary: "No-op SQL endpoint for agents service",
});

export const agentsContract = oc.router({
  ...serviceSubRouter,
  agents: {
    getOrCreate: oc
      .route({ method: "POST", path: "/api/agents/get-or-create", summary: "Get or create agent" })
      .input(GetOrCreateAgentInput)
      .output(
        z.object({
          agent: Agent,
          wasNewlyCreated: z.boolean(),
        }),
      ),
    update: oc
      .route({ method: "POST", path: "/api/agents/update", summary: "Update agent state" })
      .input(UpdateAgentInput)
      .output(z.object({ ok: z.literal(true), agent: Agent })),
    subscribe: oc
      .route({
        method: "POST",
        path: "/api/agents/subscribe",
        summary: "Subscribe to agent changes",
      })
      .input(z.object({ agentPath: z.string(), callbackUrl: z.string().url() }))
      .output(z.object({ ok: z.literal(true) })),
  },
});

export const AgentsServiceEnv = z.object({
  AGENTS_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19061),
  OPENCODE_WRAPPER_BASE_URL: z.string().default("http://127.0.0.1:19062"),
});

export const agentsServiceManifest = {
  name: packageJson.name,
  slug: "agents-service",
  version: packageJson.version ?? "0.0.0",
  port: 19061,
  orpcContract: agentsContract,
  envVars: AgentsServiceEnv,
} as const;
