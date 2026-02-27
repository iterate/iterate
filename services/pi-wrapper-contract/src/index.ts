import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Pi wrapper service health metadata",
  sqlSummary: "No-op SQL endpoint for pi wrapper",
});

export const piWrapperContract = oc.router({
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

export const PiWrapperServiceEnv = z.object({
  PI_WRAPPER_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19064),
  PI_MODEL_PROVIDER: z.string().default("openai"),
  PI_MODEL_ID: z.string().default("gpt-4o-mini"),
  PI_AGENT_DIR: z.string().default("/var/lib/jonasland/pi-agent"),
  PI_WORKING_DIRECTORY: z.string().default("/tmp"),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  EVENTS_SERVICE_BASE_URL: z.string().default("http://127.0.0.1:19010"),
  SERVICES_ORPC_URL: z.string().default("http://127.0.0.1:8777/orpc"),
});

export const piWrapperServiceManifest = {
  name: packageJson.name,
  slug: "pi-wrapper-service",
  version: packageJson.version ?? "0.0.0",
  port: 19064,
  orpcContract: piWrapperContract,
  envVars: PiWrapperServiceEnv,
} as const;
