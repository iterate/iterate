import { oc } from "@orpc/contract";
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
  },
});

export const DaemonServiceEnv = z.object({
  DAEMON_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19060),
});

export const daemonServiceManifest = {
  name: packageJson.name,
  slug: "daemon-service",
  version: packageJson.version ?? "0.0.0",
  port: 19060,
  orpcContract: daemonContract,
  envVars: DaemonServiceEnv,
} as const;
