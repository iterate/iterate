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

export const SlackRouteRecord = z.object({
  channel: z.string().min(1),
  threadTs: z.string().min(1),
  agentPath: z.string().min(1),
  providerSessionId: z.string().min(1),
  agentStreamPath: z.string().min(1),
});
export type SlackRouteRecord = z.infer<typeof SlackRouteRecord>;

export const SlackWebhookDecisionOutput = z.object({
  shouldCreateAgent: z.boolean(),
  shouldAppendPrompt: z.boolean(),
  getOrCreateInput: z.object({ agentPath: z.string().min(1) }).optional(),
  reasonCodes: z.array(z.string().min(1)),
  debug: z.record(z.string(), z.unknown()),
});
export type SlackWebhookDecisionOutput = z.infer<typeof SlackWebhookDecisionOutput>;

export const SlackCodemodeInput = z.object({
  agentPath: z.string().min(1),
  code: z.string().min(1),
});
export type SlackCodemodeInput = z.infer<typeof SlackCodemodeInput>;

export const SlackCodemodeOutput = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type SlackCodemodeOutput = z.infer<typeof SlackCodemodeOutput>;

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
    decideWebhook: oc
      .route({
        method: "POST",
        path: "/api/slack/debug/decide-webhook",
        summary: "Dry-run Slack webhook routing and agent-create decision",
      })
      .input(
        z.object({
          webhook: SlackWebhookInput,
          existingRoutes: z.array(SlackRouteRecord).optional(),
        }),
      )
      .output(SlackWebhookDecisionOutput),
    codemode: oc
      .route({
        method: "POST",
        path: "/codemode",
        summary: "Execute Slack codemode script against agent thread context",
      })
      .input(SlackCodemodeInput)
      .output(SlackCodemodeOutput),
  },
});

export const SlackServiceEnv = z.object({
  SLACK_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19063),
  SLACK_SERVICE_DB_PATH: z.string().default("slack-service.sqlite"),
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
