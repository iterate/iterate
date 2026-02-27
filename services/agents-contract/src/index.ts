import { eventIterator, oc } from "@orpc/contract";
import {
  EventStreamEvent,
  Offset,
  PushSubscriptionCallbackAddedPayload,
  StreamPath,
} from "@iterate-com/events-contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

export const Agent = z.object({
  agentPath: z.string().min(1),
  provider: z.literal("opencode"),
  sessionId: z.string().min(1),
  streamPath: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GetOrCreateAgentInput = z.object({
  agentPath: z.string().min(1),
});

const EventInputPayload = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  version: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
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
    appendToStream: oc
      .route({
        method: "POST",
        path: "/api/agents/streams/{+path}",
        summary: "Append events to an agent stream target",
      })
      .input(
        z.object({
          path: StreamPath,
          events: z.array(EventInputPayload).min(1),
        }),
      )
      .output(z.void()),
    registerStreamSubscription: oc
      .route({
        method: "POST",
        path: "/api/agents/streams/{+path}/subscriptions",
        summary: "Register a push subscription for an agent stream target",
      })
      .input(
        z.object({
          path: StreamPath,
          subscription: PushSubscriptionCallbackAddedPayload,
          idempotencyKey: z.string().min(1).optional(),
        }),
      )
      .output(z.void()),
    ackStreamSubscriptionOffset: oc
      .route({
        method: "POST",
        path: "/api/agents/streams/{+path}/subscriptions/{subscriptionSlug}/ack",
        summary: "Acknowledge offset for a push subscription on an agent stream target",
      })
      .input(
        z.object({
          path: StreamPath,
          subscriptionSlug: z.string().min(1),
          offset: Offset,
        }),
      )
      .output(z.void()),
    stream: oc
      .route({
        method: "GET",
        path: "/api/agents/streams/{+path}",
        summary: "Read an agent stream target and optionally keep stream live",
      })
      .input(
        z.object({
          path: StreamPath,
          offset: Offset.optional(),
          live: z.boolean().optional(),
        }),
      )
      .output(eventIterator(EventStreamEvent)),
  },
});

export const AgentsServiceEnv = z.object({
  AGENTS_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19061),
  OPENCODE_WRAPPER_BASE_URL: z.string().default("http://127.0.0.1:19062"),
  EVENTS_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19010"),
  AGENTS_SERVICE_DB_PATH: z.string().default("agents-service.sqlite"),
  SERVICES_ORPC_URL: z.string().default("http://127.0.0.1:8777/orpc"),
});

export const agentsServiceManifest = {
  name: packageJson.name,
  slug: "agents-service",
  version: packageJson.version ?? "0.0.0",
  port: 19061,
  orpcContract: agentsContract,
  envVars: AgentsServiceEnv,
} as const;
