import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Slack service health metadata",
  sqlSummary: "No-op SQL endpoint for slack service",
});

export const SlackWebhookEvent = z.object({
  type: z.string().optional(),
  user: z.string().optional(),
  text: z.string().optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
});

export const SlackWebhookInput = z
  .object({
    event: SlackWebhookEvent.optional(),
  })
  .passthrough();

export const slackContract = oc.router({
  ...serviceSubRouter,
  slack: {
    webhook: oc
      .route({ method: "POST", path: "/webhook", summary: "Receive Slack webhook" })
      .input(SlackWebhookInput)
      .output(
        z.object({
          ok: z.literal(true),
          queued: z.boolean(),
          streamPath: z.string(),
        }),
      ),
    integrationCallback: oc
      .route({
        method: "POST",
        path: "/internal/events/integrations",
        summary: "Receive integration stream push events",
      })
      .input(z.object({}).passthrough())
      .output(z.object({ ok: z.literal(true), handled: z.boolean() })),
    agentUpdatesCallback: oc
      .route({
        method: "POST",
        path: "/internal/events/agent-updates",
        summary: "Receive agent stream push events",
      })
      .input(z.object({}).passthrough())
      .output(z.object({ ok: z.literal(true), handled: z.boolean() })),
  },
});

export const SlackServiceEnv = z.object({
  SLACK_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19063),
  AGENTS_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19061"),
  EVENTS_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19010"),
  SLACK_API_BASE_URL: z.string().default("https://slack.com"),
  SERVICES_ORPC_URL: z.string().default("http://127.0.0.1:8777/orpc"),
});

export const slackServiceManifest = {
  name: packageJson.name,
  slug: "slack-service",
  version: packageJson.version ?? "0.0.0",
  port: 19063,
  orpcContract: slackContract,
  envVars: SlackServiceEnv,
} as const;
