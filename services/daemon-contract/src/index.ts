import { eventIterator, oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Daemon service health metadata",
  sqlSummary: "No-op SQL endpoint for daemon service",
});

export const daemonContract = oc.router({
  ...serviceSubRouter,
  tools: {
    execTs: oc
      .route({ method: "POST", path: "/api/tools/exec-ts", summary: "Execute TypeScript snippet" })
      .input(z.object({ code: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true), result: z.unknown().optional() })),
    streamShell: oc
      .route({
        method: "POST",
        path: "/api/tools/stream-shell",
        summary: "Execute shell command and stream output rows",
      })
      .input(
        z.object({
          command: z.string().min(1),
          cwd: z.string().optional(),
        }),
      )
      .output(
        eventIterator(
          z.object({
            stream: z.enum(["stdout", "stderr", "status"]),
            text: z.string(),
            timestamp: z.string(),
            exitCode: z.number().int().nullable().optional(),
            signal: z.string().nullable().optional(),
          }),
        ),
      ),
  },
});

export const DaemonServiceEnv = z.object({
  DAEMON_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19060),
  SERVICES_ORPC_URL: z.string().default("http://127.0.0.1:8777/orpc"),
});

export const daemonServiceManifest = {
  name: packageJson.name,
  slug: "daemon-service",
  version: packageJson.version ?? "0.0.0",
  port: 19060,
  orpcContract: daemonContract,
  envVars: DaemonServiceEnv,
} as const;
