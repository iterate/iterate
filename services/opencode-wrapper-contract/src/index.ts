import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "OpenCode wrapper service health metadata",
  sqlSummary: "No-op SQL endpoint for opencode wrapper",
});

export const opencodeWrapperContract = oc.router({
  ...serviceSubRouter,
  wrapper: {
    createSession: oc
      .route({ method: "POST", path: "/new", summary: "Create wrapped session" })
      .input(z.object({ agentPath: z.string() }))
      .output(
        z.object({
          route: z.string(),
          sessionId: z.string(),
          streamPath: z.string(),
        }),
      ),
    forwardSessionEvents: oc
      .route({ method: "POST", path: "/sessions/{sessionId}", summary: "Forward session events" })
      .input(
        z.object({
          sessionId: z.string(),
          events: z.array(z.object({ type: z.string(), message: z.string() })).optional(),
          slack: z
            .object({
              channel: z.string(),
              threadTs: z.string(),
            })
            .optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    providerCallback: oc
      .route({
        method: "POST",
        path: "/internal/events/provider",
        summary: "Consume agent stream push events for provider execution",
      })
      .input(z.object({}).passthrough())
      .output(z.object({ ok: z.literal(true), handled: z.boolean() })),
  },
});

export const OpencodeWrapperServiceEnv = z.object({
  OPENCODE_WRAPPER_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19062),
  OPENCODE_BASE_URL: z.string().default("http://127.0.0.1:4096"),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com"),
  SLACK_API_BASE_URL: z.string().default("https://slack.com"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENCODE_PROVIDER_ID: z.string().default("openai"),
  OPENCODE_MODEL_ID: z.string().default("gpt-4o-mini"),
  AGENTS_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19061"),
  DAEMON_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19060"),
  EVENTS_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19010"),
  SERVICES_ORPC_URL: z.string().default("http://127.0.0.1:8777/orpc"),
});

export const opencodeWrapperServiceManifest = {
  name: packageJson.name,
  slug: "opencode-wrapper-service",
  version: packageJson.version ?? "0.0.0",
  port: 19062,
  orpcContract: opencodeWrapperContract,
  envVars: OpencodeWrapperServiceEnv,
} as const;
